// obsbot-helper.exe — Windows native control helper for the OBSBOT Tiny 2.
//
// Speaks a stdio JSON-line protocol: one JSON request object per stdin
// line, one JSON response object per stdout line. Nothing else is ever
// written to stdout; diagnostics (if any) go to stderr.
//
// Ops:
//   {"op":"version"}                              -> {"ok":true,"version":"0.4.1"}
//   {"op":"enumerate"}                             -> {"ok":true,"devices":[{"path":"...","name":"..."}]}
//   {"op":"open","path":"..."}                     -> {"ok":true,"xuNode":N}
//   {"op":"nodes"}                                 -> {"ok":true,"nodes":[{"index":N,"type":"{...}"}]}
//   {"op":"xu_set","selector":S,"hex":"..."}       -> {"ok":true}
//   {"op":"xu_get","selector":S,"length":L}       -> {"ok":true,"hex":"..."}
//   {"op":"zoom_range"}                            -> {"ok":true,"min":M,"max":X}
//   {"op":"zoom_set","units":U}                    -> {"ok":true}
//   {"op":"camctrl_set","property":P,"value":V,"flags":F}  -> {"ok":true}
//   {"op":"camctrl_range","property":P}            -> {"ok":true,"min":M,"max":X}
//   {"op":"camctrl_get","property":P}             -> {"ok":true,"value":V,"flags":F}
//   {"op":"procamp_set","property":P,"value":V,"flags":F}  -> {"ok":true}
//   {"op":"procamp_range","property":P}            -> {"ok":true,"min":M,"max":X}
//   {"op":"snapshot","path?","maxDim?","quality?","settleMs?"} -> {"ok":true,"mime":"image/jpeg","width":W,"height":H,"base64":"..."}
//                                                   -> {"ok":false,"busy":true,"error":"..."} (capture pin contended)
//   any failure                                    -> {"ok":false,"error":"..."}
//
// Uses DirectShow (ICreateDevEnum / IKsTopologyInfo / IKsControl) to reach
// the UVC Extension Unit (XU) node for vendor control, and
// IAMCameraControl for the standard zoom control. See
// docs/superpowers/plans/2026-07-12-obsbot-tiny2-mcp.md (Task 5) and
// PROTOCOL.md for the design rationale and the XU descriptor GUID.

#include <windows.h>
#include <dshow.h>
#include <ks.h>
#include <ksproxy.h>
#include <ksmedia.h>
#include <vidcap.h>
#include <control.h>       // IMediaControl
#include <wincodec.h>      // WIC (JPEG encode / scale / flip)
#include <wincrypt.h>      // CryptBinaryToStringA (base64)

#include <cfgmgr32.h>      // CM_Register_Notification (device arrival/removal)
#include <string>
#include <vector>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <mutex>
#include <algorithm>
#include <cctype>

#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "crypt32.lib")

// ---------------------------------------------------------------------
// XU descriptor GUID (from PROTOCOL.md / captured device descriptor):
// {9A1E7291-6843-4683-6D92-39BC7906EE49}
//
// IMPORTANT: this is the UVC Extension Unit's *descriptor* GUID
// (guidExtensionCode). Per Microsoft's "Extension Unit Plug-In
// Architecture" doc, the DirectShow/KS topology *node* for a UVC XU is
// exposed with node type KSNODETYPE_DEV_SPECIFIC (a generic marker, the
// same for every vendor XU on every device) — the node type is NOT the
// XU descriptor GUID. Separately, the KS property SET GUID used in
// KsProperty calls against that node IS this XU descriptor GUID. These
// are two different roles for two different GUIDs; conflating them
// (matching the node by this GUID, and/or using the node's type GUID as
// the property Set) is what previously caused every xu_set to fail with
// ERROR_SET_NOT_FOUND (0x80070492) — the driver correctly reported "no
// such property set" because the code was asking for a property set
// that doesn't exist (the node-type GUID), not the one that does (this
// descriptor GUID).
// ---------------------------------------------------------------------
static const GUID XU_DESCRIPTOR_GUID = {
    0x9A1E7291, 0x6843, 0x4683,
    {0x6D, 0x92, 0x39, 0xBC, 0x79, 0x06, 0xEE, 0x49}};

// qedit.h (SampleGrabber) was removed from modern Windows SDKs — declare the
// bits we use via their documented, stable GUIDs.
interface ISampleGrabberCB : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE SampleCB(double, IMediaSample*) = 0;
  virtual HRESULT STDMETHODCALLTYPE BufferCB(double, BYTE*, long) = 0;
};
interface ISampleGrabber : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE SetOneShot(BOOL) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMediaType(const AM_MEDIA_TYPE*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetConnectedMediaType(AM_MEDIA_TYPE*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetBufferSamples(BOOL) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetCurrentBuffer(long*, long*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetCurrentSample(IMediaSample**) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetCallback(ISampleGrabberCB*, long) = 0;
};
static const CLSID CLSID_SampleGrabber =
    {0xC1F400A0,0x3F08,0x11D3,{0x9F,0x0B,0x00,0x60,0x08,0x03,0x9E,0x37}};
static const IID IID_ISampleGrabber =
    {0x6B652FFF,0x11FE,0x4FCE,{0x92,0xAD,0x02,0x66,0xB5,0xD7,0xC7,0x8F}};
static const CLSID CLSID_NullRenderer =
    {0xC1F400A4,0x3F08,0x11D3,{0x9F,0x0B,0x00,0x60,0x08,0x03,0x9E,0x37}};

// ---- tiny helpers -------------------------------------------------------

static std::string wto(const wchar_t* w) {
  if (!w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

// Render a GUID in the standard "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
// form, for the "nodes" diagnostic op and error messages.
static std::string guidToString(const GUID& g) {
  wchar_t buf[64];
  if (StringFromGUID2(g, buf, 64) <= 0) return "{invalid-guid}";
  return wto(buf);
}

static std::string toHex(const BYTE* p, size_t n) {
  static const char* H = "0123456789abcdef";
  std::string s;
  s.reserve(n * 2);
  for (size_t i = 0; i < n; ++i) {
    s += H[p[i] >> 4];
    s += H[p[i] & 0xf];
  }
  return s;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Manual nibble parser: rejects odd-length or non-hex input with a clear
// error instead of silently truncating (previous std::stoul-per-byte
// implementation dropped a trailing odd nibble and threw uncaught
// std::invalid_argument on non-hex characters).
static std::vector<BYTE> fromHex(const std::string& h) {
  if (h.size() % 2 != 0) {
    throw std::invalid_argument("hex: odd-length hex string");
  }
  std::vector<BYTE> b;
  b.reserve(h.size() / 2);
  for (size_t i = 0; i + 1 < h.size(); i += 2) {
    int hi = hexNibble(h[i]);
    int lo = hexNibble(h[i + 1]);
    if (hi < 0 || lo < 0) {
      throw std::invalid_argument("hex: invalid character in hex string");
    }
    b.push_back((BYTE)((hi << 4) | lo));
  }
  return b;
}

// Parse a 4-hex-digit value that immediately follows `key` (e.g. "vid_") in a
// DirectShow moniker path, case-insensitively. Real USB devices carry
// "usb#vid_XXXX&pid_XXXX..."; software/virtual sources (@device:sw:, NDI) do
// not, so a hit here cleanly marks a hardware camera vs a branded virtual one
// (the "OBSBOT Virtual Camera" filter has no vid/pid). Returns -1 when the key
// or its four hex digits are absent.
static int parseHexAfter(const std::string& s, const std::string& key) {
  std::string ls;
  ls.reserve(s.size());
  for (char c : s) ls += (char)tolower((unsigned char)c);
  size_t pos = ls.find(key);
  if (pos == std::string::npos) return -1;
  pos += key.size();
  if (pos + 4 > ls.size()) return -1;
  int val = 0;
  for (int i = 0; i < 4; ++i) {
    int n = hexNibble(ls[pos + i]);
    if (n < 0) return -1;
    val = (val << 4) | n;
  }
  return val;
}

// Escape a string for embedding as a JSON string value (device names /
// paths are attacker-free but may contain backslashes or quotes).
static std::string jsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

// JSON field extractor — input is machine-generated, single-line, flat
// objects only (no nested braces/arrays in values we care about). Handles
// standard JSON string escapes (backslash-quoted device paths in
// particular — Windows moniker display names are full of backslashes and
// JSON.stringify() on the Node side escapes every one of them).
static std::string field(const std::string& j, const std::string& key) {
  auto k = j.find("\"" + key + "\"");
  if (k == std::string::npos) return {};
  auto c = j.find(':', k);
  if (c == std::string::npos) return {};
  size_t i = c + 1;
  while (i < j.size() && (j[i] == ' ' || j[i] == '\t')) ++i;

  if (i < j.size() && j[i] == '"') {
    // Quoted string value: unescape as we scan.
    ++i;
    std::string out;
    while (i < j.size() && j[i] != '"') {
      if (j[i] == '\\' && i + 1 < j.size()) {
        char n = j[i + 1];
        switch (n) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'u':
            if (i + 5 < j.size()) {
              unsigned cp = (unsigned)std::stoul(j.substr(i + 2, 4), nullptr, 16);
              if (cp < 0x80) {
                out += (char)cp;
              } else if (cp < 0x800) {
                out += (char)(0xC0 | (cp >> 6));
                out += (char)(0x80 | (cp & 0x3F));
              } else {
                out += (char)(0xE0 | (cp >> 12));
                out += (char)(0x80 | ((cp >> 6) & 0x3F));
                out += (char)(0x80 | (cp & 0x3F));
              }
              i += 4;
            }
            break;
          default: out += n; break;
        }
        i += 2;
      } else {
        out += j[i];
        ++i;
      }
    }
    return out;
  }

  // Unquoted (numeric/boolean) value.
  size_t e = i;
  while (e < j.size() && j[e] != ',' && j[e] != '}' && j[e] != ' ' && j[e] != '\r' && j[e] != '\n') ++e;
  return j.substr(i, e - i);
}

// Every stdout write goes through here under one lock.
//
// Until device notifications existed, main() was the only writer and no lock was
// needed. The CM_Register_Notification callback runs on a THREAD-POOL thread, so
// an event line and a response can now be emitted concurrently; without this a
// half-written response and a half-written event interleave and BOTH become
// unparseable, desyncing the Node reader for the rest of the session.
static std::mutex g_outMutex;

static void emitLine(const std::string& line) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  std::cout << line << "\n" << std::flush;
}

static void ok(const std::string& body) {
  emitLine("{\"ok\":true" + body + "}");
}
static void err(const std::string& m) {
  emitLine("{\"ok\":false,\"error\":\"" + jsonEscape(m) + "\"}");
}
static void errHr(const std::string& m, HRESULT hr) {
  std::ostringstream o;
  o << m << " (hr=0x" << std::hex << (unsigned long)hr << ")";
  err(o.str());
}
static void busy(const std::string& m) {
  emitLine("{\"ok\":false,\"busy\":true,\"error\":\"" + jsonEscape(m) + "\"}");
}

// ---------------------------------------------------------------------------
//  Device arrival/removal notifications
// ---------------------------------------------------------------------------
//
// The Node side already understands {"event":"camera_arrived"|"camera_departed"}
// push lines; without them Windows only learns the cable moved by FAILING a call.
//
// The path contract is asymmetric, and getting it wrong fails silently:
//   - camera_departed: DeviceManager.handleCameraDeparted() matches registry
//     entries with `entry.path !== e.path` — an exact string compare. A path that
//     differs by so much as case matches nothing and the handler does nothing at
//     all, which looks exactly like the events never firing.
//   - camera_arrived: handleCameraArrived() takes `_e` and never reads the path;
//     it decides from `everBound` alone. So arrival's path is advisory.
//
// Rather than rebuild the DirectShow moniker display name from the notification's
// symbolic link by string surgery (they differ in case and decoration, so this is
// exactly where a silent mismatch would come from), every enumerate records the
// display names it produced. A departure emits the REMEMBERED string, so it is
// byte-identical to what `enumerate` reported by construction.
static std::mutex g_pathMutex;
static std::vector<std::string> g_knownPaths;

static std::string toLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return (char)std::tolower(c); });
  return s;
}

static void rememberPath(const std::string& path) {
  std::lock_guard<std::mutex> lock(g_pathMutex);
  for (const auto& p : g_knownPaths) if (p == path) return;
  g_knownPaths.push_back(path);
}

// The moniker display name embeds the device interface path, so the
// notification's symbolic link appears inside it (modulo case).
static std::string findKnownPath(const std::string& symbolicLink) {
  const std::string needle = toLower(symbolicLink);
  std::lock_guard<std::mutex> lock(g_pathMutex);
  for (const auto& p : g_knownPaths) {
    if (toLower(p).find(needle) != std::string::npos) return p;
  }
  return {};
}

// ---- global session state ------------------------------------------------
// The helper is single-connection / line-oriented: one open device at a
// time, matching the Node-side HelperProcess contract.

static IBaseFilter* g_filter = nullptr;
static IKsTopologyInfo* g_topo = nullptr;
static IKsControl* g_ks = nullptr;
static IAMCameraControl* g_camCtrl = nullptr;
static IAMVideoProcAmp* g_procAmp = nullptr;
static DWORD g_xuNode = 0;
static bool g_haveXu = false;
static std::string g_openPath;   // device moniker path of the open device (for snapshot)

static void releaseSession() {
  if (g_ks) { g_ks->Release(); g_ks = nullptr; }
  if (g_camCtrl) { g_camCtrl->Release(); g_camCtrl = nullptr; }
  if (g_procAmp) { g_procAmp->Release(); g_procAmp = nullptr; }
  if (g_topo) { g_topo->Release(); g_topo = nullptr; }
  if (g_filter) { g_filter->Release(); g_filter = nullptr; }
  g_haveXu = false;
  g_xuNode = 0;
  g_openPath.clear();
}

// ---- ops -------------------------------------------------------------

// Must match package.json's version; test/version-sync.test.ts enforces it.
static void doVersion() { ok(",\"version\":\"0.4.1\""); }

static void doEnumerate() {
  ICreateDevEnum* devEnum = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_ICreateDevEnum, (void**)&devEnum);
  if (FAILED(hr) || !devEnum) { errHr("CoCreateInstance(SystemDeviceEnum) failed", hr); return; }

  IEnumMoniker* en = nullptr;
  hr = devEnum->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &en, 0);
  if (hr != S_OK || !en) {
    // S_FALSE means "no devices" — that's a valid empty enumerate, not an error.
    devEnum->Release();
    ok(",\"devices\":[]");
    return;
  }

  std::ostringstream out;
  out << ",\"devices\":[";
  IMoniker* m = nullptr;
  bool first = true;
  while (en->Next(1, &m, nullptr) == S_OK) {
    IPropertyBag* bag = nullptr;
    VARIANT vName;
    VariantInit(&vName);
    LPOLESTR disp = nullptr;
    m->GetDisplayName(nullptr, nullptr, &disp);
    m->BindToStorage(nullptr, nullptr, IID_IPropertyBag, (void**)&bag);
    if (bag) bag->Read(L"FriendlyName", &vName, nullptr);
    std::string name = (vName.vt == VT_BSTR && vName.bstrVal) ? wto(vName.bstrVal) : "";
    std::string path = wto(disp);
    if (!first) out << ",";
    first = false;
    // USB VID/PID live in the pnp moniker ("usb#vid_XXXX&pid_XXXX..."). Emit
    // them so the manager can gate camera candidacy on hardware identity rather
    // than name; software/virtual sources have no vid/pid and are skipped.
    int vid = parseHexAfter(path, "vid_");
    int pid = parseHexAfter(path, "pid_");
    rememberPath(path);
    out << "{\"path\":\"" << jsonEscape(path) << "\",\"name\":\"" << jsonEscape(name) << "\"";
    if (vid >= 0) out << ",\"vid\":" << vid;
    if (pid >= 0) out << ",\"pid\":" << pid;
    out << "}";
    if (bag) bag->Release();
    if (disp) CoTaskMemFree(disp);
    VariantClear(&vName);
    m->Release();
  }
  out << "]";
  en->Release();
  devEnum->Release();
  ok(out.str());
}

// Bind the video-capture filter whose moniker display name equals `path`.
// Returns an AddRef'd IBaseFilter* (caller releases) or nullptr if not found.
static IBaseFilter* bindFilterByPath(const std::string& path) {
  ICreateDevEnum* devEnum = nullptr;
  if (FAILED(CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER,
                              IID_ICreateDevEnum, (void**)&devEnum)) || !devEnum) {
    return nullptr;
  }
  IEnumMoniker* en = nullptr;
  if (devEnum->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &en, 0) != S_OK || !en) {
    devEnum->Release();
    return nullptr;
  }
  IMoniker* m = nullptr;
  IBaseFilter* filter = nullptr;
  while (en->Next(1, &m, nullptr) == S_OK) {
    LPOLESTR disp = nullptr;
    m->GetDisplayName(nullptr, nullptr, &disp);
    std::string p = wto(disp);
    if (p == path) {
      m->BindToObject(nullptr, nullptr, IID_IBaseFilter, (void**)&filter);
    }
    if (disp) CoTaskMemFree(disp);
    m->Release();
    if (filter) break;
  }
  en->Release();
  devEnum->Release();
  return filter;
}

// Find the moniker whose display name matches `path`, bind it, locate the
// XU topology node, and cache everything needed for xu_set / zoom_*.
static void doOpen(const std::string& path) {
  if (path.empty()) { err("open: missing path"); return; }
  releaseSession();

  g_filter = bindFilterByPath(path);
  if (!g_filter) { err("device path not found: " + path); return; }
  g_openPath = path;

  HRESULT hr = g_filter->QueryInterface(__uuidof(IKsTopologyInfo), (void**)&g_topo);
  if (FAILED(hr) || !g_topo) {
    releaseSession();
    errHr("QueryInterface(IKsTopologyInfo) failed", hr);
    return;
  }

  DWORD count = 0;
  g_topo->get_NumNodes(&count);

  // Pass 1: the standard UVC XU node type. Per Microsoft's "Extension Unit
  // Plug-In Architecture" doc, the KS driver exposes a UVC extension unit
  // as a topology node of type KSNODETYPE_DEV_SPECIFIC — this is the
  // documented, portable way to locate the XU node (it does NOT depend on
  // knowing the vendor's XU descriptor GUID in advance).
  DWORD foundNode = 0;
  bool found = false;
  for (DWORD i = 0; i < count; ++i) {
    GUID t{};
    if (g_topo->get_NodeType(i, &t) == S_OK && IsEqualGUID(t, KSNODETYPE_DEV_SPECIFIC)) {
      foundNode = i;
      found = true;
      break;
    }
  }
  // Pass 2 (fallback): some drivers instead report the node's type GUID
  // as the XU descriptor GUID itself rather than KSNODETYPE_DEV_SPECIFIC.
  // Match on the known OBSBOT Tiny 2 XU descriptor GUID in that case.
  if (!found) {
    for (DWORD i = 0; i < count; ++i) {
      GUID t{};
      if (g_topo->get_NodeType(i, &t) == S_OK && IsEqualGUID(t, XU_DESCRIPTOR_GUID)) {
        foundNode = i;
        found = true;
        break;
      }
    }
  }

  if (!found) {
    releaseSession();
    err("no XU (extension unit) node found on this device");
    return;
  }

  hr = g_topo->CreateNodeInstance(foundNode, __uuidof(IKsControl), (void**)&g_ks);
  if (FAILED(hr) || !g_ks) {
    releaseSession();
    errHr("CreateNodeInstance(IKsControl) failed", hr);
    return;
  }
  g_xuNode = foundNode;
  g_haveXu = true;

  // IAMCameraControl (zoom/focus) and IAMVideoProcAmp (white balance) are both
  // optional standard-UVC control interfaces; the corresponding ops fail
  // cleanly if absent, so don't fail doOpen if the device doesn't expose them.
  g_filter->QueryInterface(__uuidof(IAMCameraControl), (void**)&g_camCtrl);
  g_filter->QueryInterface(__uuidof(IAMVideoProcAmp), (void**)&g_procAmp);

  std::ostringstream o;
  o << ",\"xuNode\":" << g_xuNode;
  ok(o.str());
}

// Read-only topology diagnostic: lists every KS node index and its type
// GUID as reported by IKsTopologyInfo. Safe to run any time after `open`
// (no property SET/GET is issued, no motion). Used to see the real node
// topology on hardware where the standard-vs-fallback XU node discovery
// in doOpen can't be eyeballed directly from the "open" response alone.
static void doNodes() {
  if (!g_topo) { err("nodes: no device open"); return; }
  DWORD count = 0;
  g_topo->get_NumNodes(&count);

  std::ostringstream out;
  out << ",\"nodes\":[";
  for (DWORD i = 0; i < count; ++i) {
    GUID t{};
    HRESULT hr = g_topo->get_NodeType(i, &t);
    if (i != 0) out << ",";
    out << "{\"index\":" << i << ",\"type\":\"";
    if (SUCCEEDED(hr)) {
      out << jsonEscape(guidToString(t));
    } else {
      out << "?";
    }
    out << "\"}";
  }
  out << "]";
  ok(out.str());
}

static void doXuSet(const std::string& selectorStr, const std::string& hex) {
  if (!g_haveXu || !g_ks) { err("xu_set: no device open"); return; }
  if (selectorStr.empty()) { err("xu_set: missing selector"); return; }
  ULONG selector = (ULONG)std::stoul(selectorStr);
  std::vector<BYTE> data = fromHex(hex);

  KSP_NODE ksp{};
  // The KS property SET GUID for a UVC XU node is the XU descriptor GUID
  // itself (guidExtensionCode) — NOT the topology node's type GUID (see
  // the big comment on XU_DESCRIPTOR_GUID above). This was the root cause
  // of the previous ERROR_SET_NOT_FOUND (0x80070492) failures.
  ksp.Property.Set = XU_DESCRIPTOR_GUID;
  ksp.Property.Id = selector;
  ksp.Property.Flags = KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_TOPOLOGY;
  ksp.NodeId = g_xuNode;

  ULONG bytesReturned = 0;
  HRESULT hr = g_ks->KsProperty((PKSPROPERTY)&ksp, sizeof(ksp),
                                 data.empty() ? nullptr : data.data(),
                                 (ULONG)data.size(), &bytesReturned);

  if (hr == HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND) && g_filter) {
    // Fallback: on some UVC drivers, topology-node KS properties (KSP_NODE,
    // NodeId-addressed) are only recognized through the *filter's* own
    // IKsControl — obtained by QueryInterface directly on the IBaseFilter —
    // rather than through the per-node IKsControl handed back by
    // IKsTopologyInfo::CreateNodeInstance. Both are legitimate KS filter
    // objects to issue a KSP_NODE property against (CreateNodeInstance
    // targets the node's own COM object; the filter-level IKsControl routes
    // NodeId-addressed properties through the filter's central property
    // dispatch) — some minidriver implementations only wire up the
    // dev-specific property handler on one of the two. Retry there before
    // surfacing the error.
    IKsControl* filterKs = nullptr;
    HRESULT hrQi = g_filter->QueryInterface(__uuidof(IKsControl), (void**)&filterKs);
    if (SUCCEEDED(hrQi) && filterKs) {
      ULONG bytesReturned2 = 0;
      HRESULT hr2 = filterKs->KsProperty((PKSPROPERTY)&ksp, sizeof(ksp),
                                          data.empty() ? nullptr : data.data(),
                                          (ULONG)data.size(), &bytesReturned2);
      filterKs->Release();
      if (SUCCEEDED(hr2)) { ok(""); return; }
      hr = hr2;
    }
  }

  if (FAILED(hr)) { errHr("KsProperty SET failed", hr); return; }
  ok("");
}

static void doXuGet(const std::string& selectorStr, const std::string& lengthStr) {
  if (!g_haveXu || !g_ks) { err("xu_get: no device open"); return; }
  if (selectorStr.empty()) { err("xu_get: missing selector"); return; }
  ULONG selector = (ULONG)std::stoul(selectorStr);
  ULONG length = lengthStr.empty() ? 60 : (ULONG)std::stoul(lengthStr);
  std::vector<BYTE> buf(length, 0);

  KSP_NODE ksp{};
  ksp.Property.Set = XU_DESCRIPTOR_GUID;
  ksp.Property.Id = selector;
  ksp.Property.Flags = KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_TOPOLOGY;
  ksp.NodeId = g_xuNode;

  ULONG bytesReturned = 0;
  HRESULT hr = g_ks->KsProperty((PKSPROPERTY)&ksp, sizeof(ksp),
                                 buf.data(), (ULONG)buf.size(), &bytesReturned);

  if (hr == HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND) && g_filter) {
    // Same node-vs-filter IKsControl fallback as doXuSet.
    IKsControl* filterKs = nullptr;
    HRESULT hrQi = g_filter->QueryInterface(__uuidof(IKsControl), (void**)&filterKs);
    if (SUCCEEDED(hrQi) && filterKs) {
      ULONG bytesReturned2 = 0;
      HRESULT hr2 = filterKs->KsProperty((PKSPROPERTY)&ksp, sizeof(ksp),
                                          buf.data(), (ULONG)buf.size(), &bytesReturned2);
      filterKs->Release();
      if (SUCCEEDED(hr2)) {
        ok(",\"hex\":\"" + toHex(buf.data(), buf.size()) + "\"");
        return;
      }
      hr = hr2;
    }
  }

  if (FAILED(hr)) { errHr("KsProperty GET failed", hr); return; }
  ok(",\"hex\":\"" + toHex(buf.data(), buf.size()) + "\"");
}

static void doZoomRange() {
  if (!g_camCtrl) { err("zoom_range: no device open or IAMCameraControl unavailable"); return; }
  long lo = 0, hi = 0, step = 0, def = 0, flags = 0;
  HRESULT hr = g_camCtrl->GetRange(CameraControl_Zoom, &lo, &hi, &step, &def, &flags);
  if (FAILED(hr)) { errHr("IAMCameraControl::GetRange(Zoom) failed", hr); return; }
  std::ostringstream o;
  o << ",\"min\":" << lo << ",\"max\":" << hi;
  ok(o.str());
}

static void doZoomSet(const std::string& unitsStr) {
  if (!g_camCtrl) { err("zoom_set: no device open or IAMCameraControl unavailable"); return; }
  if (unitsStr.empty()) { err("zoom_set: missing units"); return; }
  long units = std::stol(unitsStr);
  HRESULT hr = g_camCtrl->Set(CameraControl_Zoom, units, CameraControl_Flags_Manual);
  if (FAILED(hr)) { errHr("IAMCameraControl::Set(Zoom) failed", hr); return; }
  ok("");
}

// Encode a DirectShow RGB24 buffer (BGR channel order) to a base64 JPEG using
// WIC, flipping vertically when the DIB is bottom-up, and downscaling so the
// longest side is <= maxDim. Returns S_OK and fills out* on success.
static HRESULT encodeJpegBase64(const BYTE* data, UINT srcW, UINT srcH, bool bottomUp,
                                UINT stride, long maxDim, long quality,
                                std::string& outB64, UINT& outW, UINT& outH) {
  IWICImagingFactory* fac = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&fac));
  if (FAILED(hr)) return hr;

  IWICBitmap* bmp = nullptr;
  hr = fac->CreateBitmapFromMemory(srcW, srcH, GUID_WICPixelFormat24bppBGR, stride,
                                   stride * srcH, const_cast<BYTE*>(data), &bmp);
  IWICBitmapSource* src = bmp;  // borrowed; released via bmp below
  IWICBitmapFlipRotator* flip = nullptr;
  IWICBitmapScaler* scaler = nullptr;

  if (SUCCEEDED(hr) && bottomUp) {
    hr = fac->CreateBitmapFlipRotator(&flip);
    if (SUCCEEDED(hr)) hr = flip->Initialize(src, WICBitmapTransformFlipVertical);
    if (SUCCEEDED(hr)) src = flip;
  }

  outW = srcW; outH = srcH;
  if (SUCCEEDED(hr) && maxDim > 0 && (srcW > (UINT)maxDim || srcH > (UINT)maxDim)) {
    double s = (double)maxDim / (double)(srcW >= srcH ? srcW : srcH);
    UINT dw = (UINT)(srcW * s + 0.5), dh = (UINT)(srcH * s + 0.5);
    if (dw < 1) dw = 1;
    if (dh < 1) dh = 1;
    hr = fac->CreateBitmapScaler(&scaler);
    if (SUCCEEDED(hr)) hr = scaler->Initialize(src, dw, dh, WICBitmapInterpolationModeFant);
    if (SUCCEEDED(hr)) { src = scaler; outW = dw; outH = dh; }
  }

  IStream* stream = nullptr;
  IWICBitmapEncoder* enc = nullptr;
  IWICBitmapFrameEncode* frame = nullptr;
  IPropertyBag2* props = nullptr;
  if (SUCCEEDED(hr)) hr = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
  if (SUCCEEDED(hr)) hr = fac->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc);
  if (SUCCEEDED(hr)) hr = enc->Initialize(stream, WICBitmapEncoderNoCache);
  if (SUCCEEDED(hr)) hr = enc->CreateNewFrame(&frame, &props);
  if (SUCCEEDED(hr)) {
    PROPBAG2 opt{}; opt.pstrName = (LPOLESTR)L"ImageQuality";
    VARIANT v{}; v.vt = VT_R4; v.fltVal = (float)quality / 100.0f;
    props->Write(1, &opt, &v);
    hr = frame->Initialize(props);
  }
  if (SUCCEEDED(hr)) hr = frame->SetSize(outW, outH);
  WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
  if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&pf);
  if (SUCCEEDED(hr)) hr = frame->WriteSource(src, nullptr);
  if (SUCCEEDED(hr)) hr = frame->Commit();
  if (SUCCEEDED(hr)) hr = enc->Commit();

  // Read the encoded bytes back out of the HGLOBAL stream and base64 them.
  if (SUCCEEDED(hr)) {
    HGLOBAL hg = nullptr;
    hr = GetHGlobalFromStream(stream, &hg);
    if (SUCCEEDED(hr)) {
      SIZE_T n = GlobalSize(hg);
      BYTE* p = (BYTE*)GlobalLock(hg);
      DWORD b64len = 0;
      CryptBinaryToStringA(p, (DWORD)n, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF,
                           nullptr, &b64len);
      std::string s(b64len ? b64len - 1 : 0, '\0');
      if (b64len) {
        CryptBinaryToStringA(p, (DWORD)n, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF,
                             s.data(), &b64len);
      }
      outB64 = s;
      GlobalUnlock(hg);
    }
  }

  if (props) props->Release();
  if (frame) frame->Release();
  if (enc) enc->Release();
  if (stream) stream->Release();
  if (scaler) scaler->Release();
  if (flip) flip->Release();
  if (bmp) bmp->Release();
  if (fac) fac->Release();
  return hr;
}

// Mean luma over a subsampled RGB24 buffer, to detect the cold-start black frame.
static double meanLuma(const BYTE* buf, size_t n) {
  if (n < 3) return 0.0;
  double sum = 0.0; size_t count = 0;
  for (size_t i = 0; i + 2 < n; i += 3 * 64) {   // sample every 64th pixel
    sum += 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2]; // BGR
    ++count;
  }
  return count ? sum / count : 0.0;
}

static void doSnapshot(const std::string& pathArg, long maxDim, long quality, long settleMs) {
  std::string path = pathArg.empty() ? g_openPath : pathArg;
  if (path.empty()) { err("snapshot: no device open and no path given"); return; }

  IGraphBuilder* graph = nullptr;
  ICaptureGraphBuilder2* builder = nullptr;
  IBaseFilter* src = nullptr;
  IBaseFilter* grabberF = nullptr;
  IBaseFilter* nullF = nullptr;
  ISampleGrabber* grabber = nullptr;
  IMediaControl* control = nullptr;

  HRESULT hr = CoCreateInstance(CLSID_FilterGraph, nullptr, CLSCTX_INPROC_SERVER,
                                IID_IGraphBuilder, (void**)&graph);
  if (SUCCEEDED(hr))
    hr = CoCreateInstance(CLSID_CaptureGraphBuilder2, nullptr, CLSCTX_INPROC_SERVER,
                          IID_ICaptureGraphBuilder2, (void**)&builder);
  if (SUCCEEDED(hr)) hr = builder->SetFiltergraph(graph);
  if (FAILED(hr)) { errHr("snapshot: graph create failed", hr); goto cleanup; }

  src = bindFilterByPath(path);
  if (!src) { err("snapshot: device path not found: " + path); goto cleanup; }
  hr = graph->AddFilter(src, L"src");
  if (FAILED(hr)) { errHr("snapshot: AddFilter(src) failed", hr); goto cleanup; }

  hr = CoCreateInstance(CLSID_SampleGrabber, nullptr, CLSCTX_INPROC_SERVER,
                        IID_IBaseFilter, (void**)&grabberF);
  if (SUCCEEDED(hr)) hr = grabberF->QueryInterface(IID_ISampleGrabber, (void**)&grabber);
  if (FAILED(hr)) { errHr("snapshot: SampleGrabber unavailable", hr); goto cleanup; }
  {
    AM_MEDIA_TYPE mt{};
    mt.majortype = MEDIATYPE_Video;
    mt.subtype = MEDIASUBTYPE_RGB24;
    mt.formattype = GUID_NULL;
    grabber->SetMediaType(&mt);
    grabber->SetBufferSamples(TRUE);
    grabber->SetOneShot(FALSE);
  }
  hr = graph->AddFilter(grabberF, L"grabber");
  if (SUCCEEDED(hr)) hr = CoCreateInstance(CLSID_NullRenderer, nullptr, CLSCTX_INPROC_SERVER,
                                           IID_IBaseFilter, (void**)&nullF);
  if (SUCCEEDED(hr)) hr = graph->AddFilter(nullF, L"null");
  if (FAILED(hr)) { errHr("snapshot: add filters failed", hr); goto cleanup; }

  // Connect: source -> grabber -> null. Try PREVIEW pin first, then CAPTURE.
  hr = builder->RenderStream(&PIN_CATEGORY_PREVIEW, &MEDIATYPE_Video, src, grabberF, nullF);
  if (FAILED(hr))
    hr = builder->RenderStream(&PIN_CATEGORY_CAPTURE, &MEDIATYPE_Video, src, grabberF, nullF);
  if (FAILED(hr)) {
    // Failure to connect the capture pin is the contention signal.
    {
      std::ostringstream o;
      o << "camera in use by another application (hr=0x" << std::hex << (unsigned long)hr << ")";
      busy(o.str());
    }
    goto cleanup;
  }

  hr = graph->QueryInterface(IID_IMediaControl, (void**)&control);
  if (SUCCEEDED(hr)) hr = control->Run();
  if (FAILED(hr)) {
    {
      std::ostringstream o;
      o << "camera in use by another application (hr=0x" << std::hex << (unsigned long)hr << ")";
      busy(o.str());
    }
    goto cleanup;
  }

  {
    long settle = settleMs > 0 ? settleMs : 600;
    long slept = 0;
    std::vector<BYTE> buf;
    UINT width = 0, height = 0, stride = 0;
    bool bottomUp = true;
    bool haveFrame = false;

    for (;;) {
      Sleep(settle);
      slept += settle;

      long size = 0;
      if (FAILED(grabber->GetCurrentBuffer(&size, nullptr)) || size <= 0) {
        if (slept >= 2500) break;
        settle = 400;
        continue;
      }
      buf.resize(size);
      if (FAILED(grabber->GetCurrentBuffer(&size, (long*)buf.data()))) {
        if (slept >= 2500) break;
        settle = 400;
        continue;
      }

      AM_MEDIA_TYPE cmt{};
      if (SUCCEEDED(grabber->GetConnectedMediaType(&cmt)) &&
          cmt.formattype == FORMAT_VideoInfo && cmt.pbFormat) {
        VIDEOINFOHEADER* vih = (VIDEOINFOHEADER*)cmt.pbFormat;
        width = (UINT)vih->bmiHeader.biWidth;
        LONG bh = vih->bmiHeader.biHeight;
        bottomUp = bh > 0;
        height = (UINT)(bh > 0 ? bh : -bh);
        stride = ((width * 3 + 3) & ~3u);
      }
      if (cmt.pbFormat) CoTaskMemFree(cmt.pbFormat);
      if (cmt.pUnk) cmt.pUnk->Release();

      haveFrame = width > 0 && height > 0 && buf.size() >= (size_t)stride * height;
      if (haveFrame && (meanLuma(buf.data(), buf.size()) >= 6.0 || slept >= 2500)) break;
      if (slept >= 2500) break;
      settle = 500;  // still black: give exposure more time
    }

    if (control) control->Stop();

    if (!haveFrame) { err("snapshot: could not obtain a frame"); goto cleanup; }

    std::string b64;
    UINT outW = 0, outH = 0;
    hr = encodeJpegBase64(buf.data(), width, height, bottomUp, stride, maxDim, quality,
                          b64, outW, outH);
    if (FAILED(hr)) { errHr("snapshot: JPEG encode failed", hr); goto cleanup; }

    std::ostringstream o;
    o << ",\"mime\":\"image/jpeg\",\"width\":" << outW << ",\"height\":" << outH
      << ",\"base64\":\"" << b64 << "\"";
    ok(o.str());
  }

cleanup:
  if (control) { control->Stop(); control->Release(); }
  if (grabber) grabber->Release();
  if (grabberF) grabberF->Release();
  if (nullF) nullF->Release();
  if (src) src->Release();
  if (builder) builder->Release();
  if (graph) graph->Release();
}

// Generic IAMCameraControl property set/range. `property` is a CameraControl
// property id (e.g. CameraControl_Focus = 6) and `flags` is
// CameraControl_Flags_Auto (1) / _Manual (2). Used for focus.
static void doCamCtrlSet(const std::string& propStr, const std::string& valStr,
                         const std::string& flagsStr) {
  if (!g_camCtrl) { err("camctrl_set: no device open or IAMCameraControl unavailable"); return; }
  if (propStr.empty() || valStr.empty() || flagsStr.empty()) {
    err("camctrl_set: missing property/value/flags"); return;
  }
  long prop = std::stol(propStr);
  long value = std::stol(valStr);
  long flags = std::stol(flagsStr);
  HRESULT hr = g_camCtrl->Set(prop, value, flags);
  if (FAILED(hr)) { errHr("IAMCameraControl::Set failed", hr); return; }
  ok("");
}

static void doCamCtrlRange(const std::string& propStr) {
  if (!g_camCtrl) { err("camctrl_range: no device open or IAMCameraControl unavailable"); return; }
  if (propStr.empty()) { err("camctrl_range: missing property"); return; }
  long prop = std::stol(propStr);
  long lo = 0, hi = 0, step = 0, def = 0, flags = 0;
  HRESULT hr = g_camCtrl->GetRange(prop, &lo, &hi, &step, &def, &flags);
  if (FAILED(hr)) { errHr("IAMCameraControl::GetRange failed", hr); return; }
  std::ostringstream o;
  o << ",\"min\":" << lo << ",\"max\":" << hi;
  ok(o.str());
}

static void doCamCtrlGet(const std::string& propStr) {
  if (!g_camCtrl) { err("camctrl_get: no device open or IAMCameraControl unavailable"); return; }
  if (propStr.empty()) { err("camctrl_get: missing property"); return; }
  long prop = std::stol(propStr);
  long value = 0, flags = 0;
  HRESULT hr = g_camCtrl->Get(prop, &value, &flags);
  if (FAILED(hr)) { errHr("IAMCameraControl::Get failed", hr); return; }
  std::ostringstream o;
  o << ",\"value\":" << value << ",\"flags\":" << flags;
  ok(o.str());
}

// Generic IAMVideoProcAmp property set/range. `property` is a VideoProcAmp
// property id (e.g. VideoProcAmp_WhiteBalance = 7) and `flags` is
// VideoProcAmp_Flags_Auto (1) / _Manual (2). Used for white balance.
static void doProcAmpSet(const std::string& propStr, const std::string& valStr,
                         const std::string& flagsStr) {
  if (!g_procAmp) { err("procamp_set: no device open or IAMVideoProcAmp unavailable"); return; }
  if (propStr.empty() || valStr.empty() || flagsStr.empty()) {
    err("procamp_set: missing property/value/flags"); return;
  }
  long prop = std::stol(propStr);
  long value = std::stol(valStr);
  long flags = std::stol(flagsStr);
  HRESULT hr = g_procAmp->Set(prop, value, flags);
  if (FAILED(hr)) { errHr("IAMVideoProcAmp::Set failed", hr); return; }
  ok("");
}

static void doProcAmpRange(const std::string& propStr) {
  if (!g_procAmp) { err("procamp_range: no device open or IAMVideoProcAmp unavailable"); return; }
  if (propStr.empty()) { err("procamp_range: missing property"); return; }
  long prop = std::stol(propStr);
  long lo = 0, hi = 0, step = 0, def = 0, caps = 0;
  HRESULT hr = g_procAmp->GetRange(prop, &lo, &hi, &step, &def, &caps);
  if (FAILED(hr)) { errHr("IAMVideoProcAmp::GetRange failed", hr); return; }
  std::ostringstream o;
  o << ",\"min\":" << lo << ",\"max\":" << hi;
  ok(o.str());
}

// Only OBSBOT hardware should drive events. An unrelated webcam departing would
// match no registry entry (harmless), but an unrelated webcam ARRIVING would kick
// off a re-bind ladder that forks helpers for a camera that is not ours. Gate on
// the same Remo VID + model PID identity the candidacy check uses.
static bool isObsbotSymbolicLink(const std::string& link) {
  const int vid = parseHexAfter(link, "vid_");
  const int pid = parseHexAfter(link, "pid_");
  return vid == 0x3564 && pid == 0xFEF8; // Remo VID, Tiny 2
}

static void emitCameraEvent(const char* event, const std::string& path) {
  emitLine(std::string("{\"event\":\"") + event + "\",\"path\":\"" + jsonEscape(path) +
           "\",\"name\":\"OBSBOT Tiny 2\"}");
}

// Runs on a thread-pool thread — hence g_outMutex around the write. Deliberately
// does no COM work: CoInitializeEx has not run on this thread, and enumerating
// here would also block the notification callback.
static DWORD CALLBACK onDeviceNotification(HCMNOTIFICATION /*notify*/, PVOID /*ctx*/,
                                           CM_NOTIFY_ACTION action,
                                           PCM_NOTIFY_EVENT_DATA data, DWORD /*size*/) {
  if (!data || data->FilterType != CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE) return ERROR_SUCCESS;
  if (action != CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL &&
      action != CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL) {
    return ERROR_SUCCESS;
  }

  const std::string link = wto(data->u.DeviceInterface.SymbolicLink);
  if (!isObsbotSymbolicLink(link)) return ERROR_SUCCESS;

  // Both directions require a path we have actually enumerated.
  //
  // For DEPARTURE this is the exact-match contract. For ARRIVAL it is what keeps
  // the camera's OTHER interfaces out: the Tiny 2 also exposes an audio interface
  // (MI_02) which registers under KSCATEGORY_CAPTURE too and carries the same
  // VID/PID, so the identity gate alone let it through and it fired a spurious
  // second camera_arrived (observed on hardware 2026-07-21). Requiring a cached
  // path filters it without hardcoding interface numbers, and costs nothing the
  // Node side wants: handleCameraArrived only acts when `everBound` is non-empty,
  // i.e. this process bound the camera before, which means it enumerated it,
  // which means its path is cached.
  //
  // Consequence, accepted deliberately: a replug into a DIFFERENT port produces a
  // path we have never seen, so no event fires and recovery falls back to the
  // failure-driven path (device-lost signature -> prune -> re-bind). Different-port
  // replug was already the unreliable case on macOS, and it still recovers here —
  // just on the next call rather than proactively.
  const std::string known = findKnownPath(link);
  if (known.empty()) return ERROR_SUCCESS;

  const bool arrived = (action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL);
  emitCameraEvent(arrived ? "camera_arrived" : "camera_departed", known);
  return ERROR_SUCCESS;
}

int main() {
  HRESULT hrInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hrInit)) {
    std::cerr << "CoInitializeEx failed: 0x" << std::hex << hrInit << std::endl;
    return 1;
  }

  // Subscribe to capture-device interface arrival/removal. The callback runs on a
  // thread-pool thread, so no message pump and no hidden window are needed and
  // main()'s blocking getline loop below is untouched. (RegisterDeviceNotification
  // + WM_DEVICECHANGE would have required both.)
  HCMNOTIFICATION notify = nullptr;
  {
    CM_NOTIFY_FILTER filter{};
    filter.cbSize = sizeof(filter);
    filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
    filter.u.DeviceInterface.ClassGuid = KSCATEGORY_CAPTURE;
    const CONFIGRET cr = CM_Register_Notification(&filter, nullptr, onDeviceNotification, &notify);
    if (cr != CR_SUCCESS) {
      // Non-fatal: without events the helper still works exactly as before,
      // discovering a moved cable by failing a call. Don't take the process down.
      std::cerr << "CM_Register_Notification failed: " << cr
                << " (device arrival/removal events disabled)" << std::endl;
      notify = nullptr;
    }
  }

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    // Any exception thrown while parsing/handling a request (e.g.
    // std::stoul/std::stol throwing invalid_argument/out_of_range on
    // malformed numeric fields, or fromHex rejecting bad hex) must be
    // turned into an {"ok":false,...} response rather than propagating out
    // of the loop — an uncaught exception here would call std::terminate()
    // and kill the whole helper process, dropping the open-device session.
    try {
      std::string op = field(line, "op");
      if (op == "version") {
        doVersion();
      } else if (op == "enumerate") {
        doEnumerate();
      } else if (op == "open") {
        doOpen(field(line, "path"));
      } else if (op == "nodes") {
        doNodes();
      } else if (op == "xu_set") {
        doXuSet(field(line, "selector"), field(line, "hex"));
      } else if (op == "xu_get") {
        doXuGet(field(line, "selector"), field(line, "length"));
      } else if (op == "zoom_range") {
        doZoomRange();
      } else if (op == "zoom_set") {
        doZoomSet(field(line, "units"));
      } else if (op == "camctrl_set") {
        doCamCtrlSet(field(line, "property"), field(line, "value"), field(line, "flags"));
      } else if (op == "camctrl_range") {
        doCamCtrlRange(field(line, "property"));
      } else if (op == "camctrl_get") {
        doCamCtrlGet(field(line, "property"));
      } else if (op == "procamp_set") {
        doProcAmpSet(field(line, "property"), field(line, "value"), field(line, "flags"));
      } else if (op == "procamp_range") {
        doProcAmpRange(field(line, "property"));
      } else if (op == "snapshot") {
        std::string mx = field(line, "maxDim");
        std::string q = field(line, "quality");
        std::string st = field(line, "settleMs");
        doSnapshot(field(line, "path"),
                   mx.empty() ? 1024 : std::stol(mx),
                   q.empty() ? 80 : std::stol(q),
                   st.empty() ? 600 : std::stol(st));
      } else {
        err("unknown op: " + op);
      }
    } catch (const std::exception& e) {
      err(e.what());
    } catch (...) {
      err("unhandled exception");
    }
  }

  // Unregister BEFORE releasing the session: the callback may be running on a
  // pool thread right now, and CM_Unregister_Notification waits for it to finish.
  if (notify) CM_Unregister_Notification(notify);
  releaseSession();
  CoUninitialize();
  return 0;
}
