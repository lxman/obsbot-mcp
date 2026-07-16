// obsbot-helper — macOS native control helper for the OBSBOT Tiny 2.
//
// Speaks the same stdio JSON-line protocol as the Windows C++ helper:
// one JSON request per stdin line, one JSON response per stdout line.
// Diagnostics go to stderr.
//
// Ops: version, enumerate, open, xu_set, xu_get, zoom_range, zoom_set,
//      camctrl_set/range/get, procamp_set/range, snapshot
//
// Uses IOKit for USB control transfers (UVC Extension Unit vendor commands
// and standard UVC camera/processing-unit controls), and AVFoundation for
// device enumeration and snapshot.  Camera not plugged in?  Every op fails
// gracefully with {"ok":false,"error":"..."} — no crashes, no hangs.
//
// On modern macOS (Ventura+), UVCAssistant (a DriverKit system extension)
// claims the camera's UVC interfaces exclusively.  USBInterfaceOpen — and
// USBInterfaceOpenSeize — on the VideoControl interface both fail with
// kIOReturnExclusiveAccess (0xe00002c5); a userspace IOUSBLib client cannot
// take an interface a dext owns.
//
// The device itself, however, is *not* locked.  USBDeviceOpen succeeds, and
// UVC control requests (which are class requests with an interface recipient)
// can be issued on the device's default control endpoint via DeviceRequest.
// That gives us XU and standard-control access while UVCAssistant keeps
// driving the stream — the camera keeps working as a normal webcam.
//
// wIndex for these requests is (entityID << 8) | bInterfaceNumber, where
// bInterfaceNumber is the VideoControl interface (read from the IORegistry;
// 0 on the Tiny 2).  The entity low byte is the interface, NOT the entity —
// getting this wrong silently addresses the wrong recipient.
//
// Build:
//   xcrun clang -fobjc-arc -framework IOKit -framework AVFoundation \
//     -framework CoreMedia -framework CoreVideo -framework AppKit \
//     -o obsbot-helper helper.m

#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/IOCFPlugIn.h>
#import <IOKit/usb/IOUSBLib.h>
#import <IOKit/usb/USBSpec.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <AppKit/AppKit.h>
#import <os/log.h>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// OBSBOT Tiny 2 USB identifiers
static const uint16_t OBSBOT_VID = 0x3564;
static const uint16_t TINY2_PID  = 0xFEF8;

// UVC entity IDs (from PROTOCOL.md — confirmed on hardware)
static const uint8_t  UVC_CT       = 0x01;  // Camera Terminal: zoom, exposure
static const uint8_t  UVC_XU       = 0x02;  // Extension Unit: vendor commands
static const uint8_t  UVC_PU       = 0x03;  // Processing Unit: focus, procamp

// ---------------------------------------------------------------------------
// JSON helpers (pure C, same field-parser contract as windows/helper.cpp)
// ---------------------------------------------------------------------------

static NSString *jsonEscape(NSString *s) {
  if (!s) return @"null";
  NSMutableString *out = [NSMutableString stringWithCapacity:s.length + 8];
  for (NSUInteger i = 0; i < s.length; i++) {
    unichar c = [s characterAtIndex:i];
    switch (c) {
      case '"':  [out appendString:@"\\\""]; break;
      case '\\': [out appendString:@"\\\\"]; break;
      case '\n': [out appendString:@"\\n"];  break;
      case '\r': [out appendString:@"\\r"];  break;
      case '\t': [out appendString:@"\\t"];  break;
      default:
        if (c < 0x20) [out appendFormat:@"\\u%04x", (unsigned)c];
        else          [out appendFormat:@"%C", c];
    }
  }
  return out;
}

// Extract a string field from a flat JSON line (no nesting).
static NSString *jsonField(NSString *json, NSString *key) {
  NSRange r = [json rangeOfString:[NSString stringWithFormat:@"\"%@\"", key]];
  if (r.location == NSNotFound) return nil;
  NSUInteger colon = [json rangeOfString:@":" options:0 range:NSMakeRange(NSMaxRange(r), json.length - NSMaxRange(r))].location;
  if (colon == NSNotFound) return nil;
  NSUInteger i = colon + 1;
  while (i < json.length &&
         ([json characterAtIndex:i] == ' ' || [json characterAtIndex:i] == '\t'))
    i++;
  if (i >= json.length) return nil;
  if ([json characterAtIndex:i] == '"') {
    // Quoted string — unescape as we scan.
    NSMutableString *val = [NSMutableString string];
    i++;
    while (i < json.length && [json characterAtIndex:i] != '"') {
      unichar c = [json characterAtIndex:i];
      if (c == '\\' && i + 1 < json.length) {
        unichar n = [json characterAtIndex:i+1];
        switch (n) {
          case '"': [val appendString:@"\""]; break;
          case '\\':[val appendString:@"\\"]; break;
          case '/': [val appendString:@"/"];  break;
          case 'n': [val appendString:@"\n"]; break;
          case 't': [val appendString:@"\t"]; break;
          case 'r': [val appendString:@"\r"]; break;
          default:  [val appendFormat:@"%C", n]; break;
        }
        i += 2;
      } else {
        [val appendFormat:@"%C", c];
        i++;
      }
    }
    return val;
  }
  // Unquoted numeric/boolean value.
  NSUInteger end = i;
  while (end < json.length &&
         [json characterAtIndex:end] != ',' &&
         [json characterAtIndex:end] != '}' &&
         [json characterAtIndex:end] != ' ' &&
         [json characterAtIndex:end] != '\r' &&
         [json characterAtIndex:end] != '\n')
    end++;
  return [json substringWithRange:NSMakeRange(i, end - i)];
}

static NSString *toHex(const uint8_t *buf, size_t len) {
  static const char hex[] = "0123456789abcdef";
  NSMutableString *s = [NSMutableString stringWithCapacity:len * 2];
  for (size_t i = 0; i < len; i++) {
    [s appendFormat:@"%c%c", hex[buf[i] >> 4], hex[buf[i] & 0xf]];
  }
  return s;
}

static NSData *fromHex(NSString *hexStr) {
  if (hexStr.length % 2 != 0) return nil;
  NSMutableData *data = [NSMutableData dataWithLength:hexStr.length / 2];
  uint8_t *bytes = (uint8_t *)data.mutableBytes;
  for (NSUInteger i = 0; i + 1 < hexStr.length; i += 2) {
    unsigned int byte = 0;
    sscanf([[hexStr substringWithRange:NSMakeRange(i, 2)] UTF8String], "%02x", &byte);
    bytes[i / 2] = (uint8_t)byte;
  }
  return data;
}

static void respond(NSString *body) {
  fprintf(stdout, "%s\n", [body UTF8String]);
  fflush(stdout);
}

static void ok(NSString *extra) {
  respond([NSString stringWithFormat:@"{\"ok\":true%@}", extra ?: @""]);
}

static void err(NSString *msg) {
  respond([NSString stringWithFormat:@"{\"ok\":false,\"error\":\"%@\"}", jsonEscape(msg)]);
}

static void busy(NSString *msg) {
  respond([NSString stringWithFormat:@"{\"ok\":false,\"busy\":true,\"error\":\"%@\"}", jsonEscape(msg)]);
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

// One open device at a time (matches the Node-side HelperProcess contract).
// We hold an AVFoundation device reference (for snapshot) and an open
// IOUSBDeviceInterface (for control transfers on the default control
// endpoint).  ctrlInterfaceNum is the VideoControl interface number, needed
// for the low byte of wIndex on every UVC control request.
@interface MacSession : NSObject
@property (nonatomic, strong) AVCaptureDevice        *device;
@property (nonatomic, strong) NSString               *devicePath;
@property (nonatomic)         IOUSBDeviceInterface  **usbDevice;
@property (nonatomic)         uint8_t                 ctrlInterfaceNum;
@property (nonatomic, strong) NSNumber               *xuNode;
@end

@implementation MacSession
- (void)dealloc {
  if (_usbDevice) {
    (*_usbDevice)->USBDeviceClose(_usbDevice);
    (*_usbDevice)->Release(_usbDevice);
    _usbDevice = NULL;
  }
}
@end

static MacSession *g_session = nil;

static void releaseSession(void) {
  g_session = nil;
}

// ---------------------------------------------------------------------------
// IOKit USB helpers
// ---------------------------------------------------------------------------

// Find the VideoControl interface number (class 0x0E / subclass 0x01) by
// reading IORegistry properties.  We never open the interface — UVCAssistant
// owns it — we only need its bInterfaceNumber for the low byte of wIndex.
// Returns NO if the device exposes no VideoControl interface.
static BOOL findVideoControlInterfaceNumber(io_service_t deviceService,
                                            uint8_t *outNum) {
  io_iterator_t childIter = 0;
  IOReturn kr = IORegistryEntryCreateIterator(
      deviceService, kIOServicePlane,
      kIORegistryIterateRecursively, &childIter);
  if (kr != kIOReturnSuccess || !childIter) return NO;

  BOOL found = NO;
  io_service_t child;
  while ((child = IOIteratorNext(childIter))) {
    CFMutableDictionaryRef props = NULL;
    kr = IORegistryEntryCreateCFProperties(child, &props,
                                           kCFAllocatorDefault, kNilOptions);
    if (kr != kIOReturnSuccess || !props) {
      if (props) CFRelease(props);
      IOObjectRelease(child);
      continue;
    }
    NSDictionary *d = (__bridge NSDictionary *)props;
    BOOL isUvcControl =
        [d[@"bInterfaceClass"] unsignedCharValue] == kUSBVideoInterfaceClass &&
        [d[@"bInterfaceSubClass"] unsignedCharValue] == kUSBVideoControlSubClass;
    if (isUvcControl) {
      *outNum = [d[@"bInterfaceNumber"] unsignedCharValue];
      found = YES;
    }
    CFRelease(props);
    IOObjectRelease(child);
    if (found) break;
  }
  IOObjectRelease(childIter);
  return found;
}

// Open the USB device itself and return an IOUSBDeviceInterface.
//
// UVCAssistant owns the UVC *interfaces*, but not the device, so USBDeviceOpen
// succeeds and we can issue control requests on the default control endpoint
// while the camera keeps streaming.  On failure, *outKr carries the IOKit code
// so the caller can report it rather than guessing.
static IOUSBDeviceInterface **openUsbDevice(io_service_t deviceService,
                                            IOReturn *outKr) {
  IOCFPlugInInterface **plugIn = NULL;
  SInt32 score = 0;
  IOReturn kr = IOCreatePlugInInterfaceForService(deviceService,
                                                  kIOUSBDeviceUserClientTypeID,
                                                  kIOCFPlugInInterfaceID,
                                                  &plugIn, &score);
  if (kr != kIOReturnSuccess || !plugIn) { *outKr = kr; return NULL; }

  IOUSBDeviceInterface **udev = NULL;
  HRESULT res = (*plugIn)->QueryInterface(
      plugIn, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&udev);
  (*plugIn)->Release(plugIn);
  if (res != S_OK || !udev) { *outKr = kIOReturnNoDevice; return NULL; }

  kr = (*udev)->USBDeviceOpen(udev);
  if (kr != kIOReturnSuccess) {
    os_log_info(OS_LOG_DEFAULT, "openUsbDevice: USBDeviceOpen failed 0x%x", kr);
    (*udev)->Release(udev);
    *outKr = kr;
    return NULL;
  }
  *outKr = kIOReturnSuccess;
  return udev;
}

// Enumerate IOUSB devices matching vendor/product ID.
// Returns an array of io_service_t wrapped in NSNumber.
static NSMutableArray *findUsbServices(uint16_t vid, uint16_t pid) {
  NSMutableArray *services = [NSMutableArray array];
  CFMutableDictionaryRef matching = IOServiceMatching(kIOUSBDeviceClassName);
  if (!matching) return services;

  // Use SInt32 to avoid signed overflow on PIDs > 0x7FFF (e.g. 0xFEF8).
  uint32_t v = vid, p = pid;
  CFNumberRef vidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &v);
  CFNumberRef pidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &p);
  CFDictionarySetValue(matching, CFSTR("idVendor"),  vidNum);
  CFDictionarySetValue(matching, CFSTR("idProduct"), pidNum);
  CFRelease(vidNum);
  CFRelease(pidNum);

  io_iterator_t iter = 0;
  if (IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iter) != kIOReturnSuccess)
    return services;

  io_service_t service;
  while ((service = IOIteratorNext(iter)))
    [services addObject:@((uintptr_t)service)];

  IOObjectRelease(iter);
  return services;
}

// ---------------------------------------------------------------------------
// AVFoundation helpers
// ---------------------------------------------------------------------------

// Enumerate all external (USB) video cameras via AVFoundation.
// Returns array of @{@"name": ..., @"uniqueID": ...}
static NSArray *avfEnumerateCameras(void) {
  AVCaptureDeviceDiscoverySession *session = [AVCaptureDeviceDiscoverySession
      discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeExternal]
                            mediaType:AVMediaTypeVideo
                             position:AVCaptureDevicePositionUnspecified];
  NSMutableArray *result = [NSMutableArray array];
  for (AVCaptureDevice *dev in session.devices) {
    [result addObject:@{
      @"name":     dev.localizedName ?: @"",
      @"uniqueID": dev.uniqueID       ?: @"",
    }];
  }
  return result;
}

// ---------------------------------------------------------------------------
// UVC control transfers
// ---------------------------------------------------------------------------

// Perform a UVC control transfer on the device's default control endpoint.
//
// These are class requests with an interface recipient, so wIndex is
// (entityID << 8) | bInterfaceNumber — the entity in the HIGH byte and the
// VideoControl interface in the LOW byte.  Sending a bare entityId here
// addresses interface `entityId` with entity 0 instead, which the device
// answers with a stall or the wrong entity's data.
static IOReturn uvcControl(IOUSBDeviceInterface **udev,
                           uint8_t  bmRequestType,
                           uint8_t  bRequest,
                           uint8_t  controlSelector,
                           uint8_t  entityId,
                           void    *data,
                           uint16_t wLength) {
  if (!udev) return kIOReturnNotOpen;
  IOUSBDevRequest req = {0};
  req.bmRequestType = bmRequestType;
  req.bRequest      = bRequest;
  req.wValue        = (uint16_t)(controlSelector << 8);
  req.wIndex        = (uint16_t)((entityId << 8) | g_session.ctrlInterfaceNum);
  req.wLength       = wLength;
  req.pData         = data;
  return (*udev)->DeviceRequest(udev, &req);
}

static IOReturn uvcGetCur(IOUSBDeviceInterface **intf,
                          uint8_t selector,
                          uint8_t entityId,
                          void *buf,
                          uint16_t len) {
  return uvcControl(intf, 0xA1, 0x81, selector, entityId, buf, len);
}

static IOReturn uvcSetCur(IOUSBDeviceInterface **intf,
                          uint8_t selector,
                          uint8_t entityId,
                          const void *buf,
                          uint16_t len) {
  return uvcControl(intf, 0x21, 0x01, selector, entityId, (void *)buf, len);
}

static IOReturn uvcGetMin(IOUSBDeviceInterface **intf,
                          uint8_t selector,
                          uint8_t entityId,
                          void *buf,
                          uint16_t len) {
  return uvcControl(intf, 0xA1, 0x82, selector, entityId, buf, len);
}

static IOReturn uvcGetMax(IOUSBDeviceInterface **intf,
                          uint8_t selector,
                          uint8_t entityId,
                          void *buf,
                          uint16_t len) {
  return uvcControl(intf, 0xA1, 0x83, selector, entityId, buf, len);
}

// ---------------------------------------------------------------------------
// IAMCameraControl property → UVC selector/entity mapping
// ---------------------------------------------------------------------------
static uint8_t camctrlSel(long prop) {
  switch ((int)prop) {
    case 0: case 1: return 0x0E; // CT_PANTILT_ABSOLUTE
    case 4:          return 0x0D; // CT_EXPOSURE_TIME_ABSOLUTE
    case 6:          return 0x10; // PU_FOCUS_ABSOLUTE
    default:         return 0;
  }
}

static uint8_t camctrlEnt(long prop) {
  switch ((int)prop) {
    case 0: case 1: case 4: return UVC_CT;
    case 6:                 return UVC_PU;
    default:                return 0;
  }
}

// IAMVideoProcAmp property → UVC PU selector mapping
static uint8_t procampSel(long prop) {
  switch ((int)prop) {
    case 0: return 0x02; // PU_BRIGHTNESS
    case 1: return 0x03; // PU_CONTRAST
    case 2: return 0x06; // PU_HUE_ABSOLUTE
    case 3: return 0x07; // PU_SATURATION
    case 4: return 0x08; // PU_SHARPNESS
    case 7: return 0x0A; // PU_WHITEBALANCE_TEMPERATURE
    case 8: return 0x09; // PU_BACKLIGHT_COMPENSATION
    case 9: return 0x0B; // PU_GAIN
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Snapshot via AVFoundation
// ---------------------------------------------------------------------------

// `done` is set from the capture callback and polled by a run-loop pump rather
// than waited on with a semaphore: AVFoundation delivers this callback through
// the run loop, so blocking the thread waiting for it deadlocks — the callback
// can never arrive while we are the one not servicing the run loop.
@interface SnapshotDelegate : NSObject <AVCapturePhotoCaptureDelegate>
@property (atomic)            BOOL               done;
@property (nonatomic, strong) NSData            *jpegData;
@property (nonatomic)         CMVideoDimensions  dims;
@end

@implementation SnapshotDelegate
- (void)captureOutput:(AVCapturePhotoOutput *)output
  didFinishProcessingPhoto:(AVCapturePhoto *)photo
                    error:(NSError *)error {
  (void)output;
  if (error) {
    os_log_error(OS_LOG_DEFAULT, "snapshot: %{public}@", error.localizedDescription);
    self.done = YES;
    return;
  }
  self.jpegData = [photo fileDataRepresentation];
  self.dims = photo.resolvedSettings.photoDimensions;
  self.done = YES;
}
@end

// Service the run loop for `seconds`, instead of sleeping. Used both to let the
// capture session settle and to wait for the photo callback.
static void pumpRunLoop(NSTimeInterval seconds) {
  NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while ([until timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:until];
  }
}

// ---------------------------------------------------------------------------
// Op handlers
// ---------------------------------------------------------------------------

static void doVersion(void) {
  ok(@",\"version\":\"0.1.0-macos\"");
}

static void doEnumerate(void) {
  NSArray *avDevices = avfEnumerateCameras();
  NSArray *usbServices = findUsbServices(OBSBOT_VID, TINY2_PID);
  NSMutableArray *deviceList = [NSMutableArray array];

  if (usbServices.count > 0) {
    for (NSNumber *svcNum in usbServices) {
      io_service_t service = (io_service_t)(uintptr_t)[svcNum unsignedLongValue];

      // Read product name and serial from IORegistry properties directly
      // (no need to open the device exclusively).
      CFMutableDictionaryRef props = NULL;
      NSString *product = nil;
      NSString *serial  = nil;
      if (IORegistryEntryCreateCFProperties(service, &props,
                                            kCFAllocatorDefault, kNilOptions)
          == kIOReturnSuccess && props) {
        NSDictionary *dict = (__bridge NSDictionary *)props;
        product = [dict objectForKey:@"kUSBProductString"];
        serial  = [dict objectForKey:@"kUSBSerialNumberString"];
        CFRelease(props);
      }

      if (!product) product = @"OBSBOT Tiny 2";

      NSString *avUniqueID = serial ?: @"";
      for (NSDictionary *avDev in avDevices) {
        NSString *uid = avDev[@"uniqueID"];
        if (!uid || uid.length == 0) continue;
        if (serial && [uid localizedCaseInsensitiveContainsString:serial]) {
          avUniqueID = uid;
          break;
        }
        // Some OBSBOT units have no USB serial descriptor (iSerialNumber = 0).
        // Fall back to matching by product name against the AVFoundation name.
        if (!serial) {
          NSString *name = avDev[@"name"];
          if (name && [name localizedCaseInsensitiveContainsString:product]) {
            avUniqueID = uid;
            break;
          }
        }
      }
      [deviceList addObject:@{
        @"path": avUniqueID ?: @"",
        @"name": product,
      }];
    }
  } else {
    // No OBSBOT USB devices — list any external cameras via AVFoundation.
    for (NSDictionary *avDev in avDevices) {
      [deviceList addObject:@{
        @"path": avDev[@"uniqueID"] ?: @"",
        @"name": avDev[@"name"]     ?: @"",
      }];
    }
  }

  for (NSNumber *svcNum in usbServices) {
    IOObjectRelease((io_service_t)(uintptr_t)[svcNum unsignedLongValue]);
  }

  NSError *jsonErr = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:deviceList
                                                 options:0 error:&jsonErr];
  NSString *jsonStr = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"[]";
  ok([NSString stringWithFormat:@",\"devices\":%@", jsonStr]);
}

static void doOpen(NSString *path) {
  if (!path || path.length == 0) { err(@"open: missing path"); return; }
  releaseSession();

  AVCaptureDevice *avDev = [AVCaptureDevice deviceWithUniqueID:path];
  if (!avDev) {
    err([NSString stringWithFormat:@"open: no camera with uniqueID '%@'", path]);
    return;
  }

  // Find the matching USB device service, read its VideoControl interface
  // number, and open the *device* (not the interface — UVCAssistant owns that)
  // for control transfers on the default control endpoint.
  NSArray *services = findUsbServices(OBSBOT_VID, TINY2_PID);
  IOUSBDeviceInterface **udev = NULL;
  uint8_t ctrlIfNum = 0;
  BOOL haveCtrlIf = NO;
  IOReturn openKr = kIOReturnNoDevice;

  for (NSNumber *svcNum in services) {
    io_service_t svc = (io_service_t)(uintptr_t)[svcNum unsignedLongValue];

    if (!udev) {
      // Read the serial number from IORegistry to match against AVFoundation UID.
      CFMutableDictionaryRef props = NULL;
      NSString *serial = nil;
      if (IORegistryEntryCreateCFProperties(svc, &props,
                                            kCFAllocatorDefault, kNilOptions)
          == kIOReturnSuccess && props) {
        serial = [(__bridge NSDictionary *)props objectForKey:@"kUSBSerialNumberString"];
        CFRelease(props);
      }
      BOOL matches = (serial && [path localizedCaseInsensitiveContainsString:serial]) ||
                     (services.count == 1);

      if (matches) {
        haveCtrlIf = findVideoControlInterfaceNumber(svc, &ctrlIfNum);
        udev = openUsbDevice(svc, &openKr);
      }
    }
    // The device interface retains what it needs, so the service can always be
    // released here — exactly once, whether or not we opened it.
    IOObjectRelease(svc);
  }

  if (!udev) {
    err([NSString stringWithFormat:
         @"open: cannot open USB device for control (0x%x)", openKr]);
    return;
  }

  if (!haveCtrlIf) {
    (*udev)->USBDeviceClose(udev);
    (*udev)->Release(udev);
    err(@"open: device has no UVC VideoControl interface");
    return;
  }

  g_session = [[MacSession alloc] init];
  g_session.device = avDev;
  g_session.devicePath = path;
  g_session.usbDevice = udev;
  g_session.ctrlInterfaceNum = ctrlIfNum;
  g_session.xuNode = @(UVC_XU);

  // Report the real XU unit id, matching the Windows/Linux helpers.  Never
  // claim success without a control path: the Node side treats xuNode >= 0 as
  // "this device has a working XU transport".
  ok([NSString stringWithFormat:@",\"xuNode\":%d", UVC_XU]);
}

// ---------------------------------------------------------------------------
// XU ops
// ---------------------------------------------------------------------------

static void doXuSet(NSString *selStr, NSString *hex) {
  if (!g_session.usbDevice) { err(@"xu_set: no device open"); return; }
  int selector = selStr ? [selStr intValue] : 0;
  NSData *data = fromHex(hex);
  if (!data) { err(@"xu_set: invalid hex"); return; }

  IOReturn kr = uvcSetCur(g_session.usbDevice,
                           (uint8_t)selector, UVC_XU,
                           data.bytes, (uint16_t)data.length);
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"xu_set: USB control request failed (0x%x)", kr]);
    return;
  }
  ok(@"");
}

static void doXuGet(NSString *selStr, NSString *lenStr) {
  if (!g_session.usbDevice) { err(@"xu_get: no device open"); return; }
  int selector = selStr ? [selStr intValue] : 0;
  int length = lenStr ? [lenStr intValue] : 60;
  if (length < 1 || length > 4096) { err(@"xu_get: invalid length"); return; }

  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)length];
  IOReturn kr = uvcGetCur(g_session.usbDevice,
                           (uint8_t)selector, UVC_XU,
                           data.mutableBytes, (uint16_t)data.length);
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"xu_get: USB control request failed (0x%x)", kr]);
    return;
  }
  ok([NSString stringWithFormat:@",\"hex\":\"%@\"", toHex(data.bytes, data.length)]);
}

// ---------------------------------------------------------------------------
// Standard UVC zoom — CT_ZOOM_ABSOLUTE on camera terminal
// ---------------------------------------------------------------------------

static void doZoomRange(void) {
  if (!g_session.usbDevice) { err(@"zoom_range: no device open"); return; }
  int16_t min = 0, max = 0;
  IOReturn kr = uvcGetMin(g_session.usbDevice, 0x0B,
                           UVC_CT, &min, sizeof(min));
  if (kr == kIOReturnSuccess)
    kr = uvcGetMax(g_session.usbDevice, 0x0B,
                   UVC_CT, &max, sizeof(max));
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"zoom_range: GET_MIN/MAX failed (0x%x)", kr]);
    return;
  }
  ok([NSString stringWithFormat:@",\"min\":%d,\"max\":%d", min, max]);
}

static void doZoomSet(NSString *unitsStr) {
  if (!g_session.usbDevice) { err(@"zoom_set: no device open"); return; }
  int16_t units = (int16_t)(unitsStr ? [unitsStr intValue] : 0);
  IOReturn kr = uvcSetCur(g_session.usbDevice, 0x0B,
                           UVC_CT, &units, sizeof(units));
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"zoom_set: SET_CUR failed (0x%x)", kr]);
    return;
  }
  ok(@"");
}

// ---------------------------------------------------------------------------
// IAMCameraControl equivalents (focus, exposure, pan, tilt)
// ---------------------------------------------------------------------------

static void doCamCtrlSet(NSString *propStr, NSString *valStr, NSString *flagsStr) {
  (void)flagsStr;
  if (!g_session.usbDevice) { err(@"camctrl_set: no device open"); return; }
  long prop = [propStr integerValue];
  long value = [valStr integerValue];
  uint8_t sel = camctrlSel(prop);
  uint8_t ent = camctrlEnt(prop);
  if (sel == 0) { err(@"camctrl_set: unsupported property"); return; }

  if (prop == 0 || prop == 1) {
    // Pan/Tilt: two int16 values (0x0E selector).
    int16_t buf[2] = {(int16_t)value, 0};
    IOReturn kr = uvcSetCur(g_session.usbDevice, sel, ent, buf, sizeof(buf));
    if (kr != kIOReturnSuccess) {
      err([NSString stringWithFormat:@"camctrl_set: SET_CUR pan/tilt failed (0x%x)", kr]);
      return;
    }
  } else {
    // Focus/exposure: 4-byte int32 value.
    int32_t v = (int32_t)value;
    IOReturn kr = uvcSetCur(g_session.usbDevice, sel, ent, &v, sizeof(v));
    if (kr != kIOReturnSuccess) {
      err([NSString stringWithFormat:@"camctrl_set: SET_CUR failed (0x%x)", kr]);
      return;
    }
  }
  ok(@"");
}

static void doCamCtrlRange(NSString *propStr) {
  if (!g_session.usbDevice) { err(@"camctrl_range: no device open"); return; }
  long prop = [propStr integerValue];
  uint8_t sel = camctrlSel(prop);
  uint8_t ent = camctrlEnt(prop);
  if (sel == 0) { err(@"camctrl_range: unsupported property"); return; }

  int32_t min = 0, max = 0;
  IOReturn kr = uvcGetMin(g_session.usbDevice, sel, ent, &min, sizeof(min));
  if (kr == kIOReturnSuccess)
    kr = uvcGetMax(g_session.usbDevice, sel, ent, &max, sizeof(max));
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"camctrl_range: GET_MIN/MAX failed (0x%x)", kr]);
    return;
  }
  ok([NSString stringWithFormat:@",\"min\":%d,\"max\":%d", min, max]);
}

static void doCamCtrlGet(NSString *propStr) {
  if (!g_session.usbDevice) { err(@"camctrl_get: no device open"); return; }
  long prop = [propStr integerValue];
  uint8_t sel = camctrlSel(prop);
  uint8_t ent = camctrlEnt(prop);
  if (sel == 0) { err(@"camctrl_get: unsupported property"); return; }

  if (prop == 0 || prop == 1) {
    // The Tiny 2's pan/tilt control (selector 0x0E) is a 4-byte pair of int16:
    // pan at offset 0, tilt at offset 2 — the same layout doCamCtrlSet writes.
    // The old code read the whole 4 bytes as one int32 and returned it for BOTH
    // pan and tilt, so tilt never saw its own field and obsbot_gimbal_position
    // reported pitch == -yaw. Confirmed on hardware: yaw moves the pan int16 and
    // leaves the tilt int16 fixed, and vice-versa.
    struct __attribute__((packed)) { int16_t pan; int16_t tilt; } pt = {0, 0};
    IOReturn kr = uvcGetCur(g_session.usbDevice, sel, ent, &pt, sizeof(pt));
    if (kr != kIOReturnSuccess) {
      err([NSString stringWithFormat:@"camctrl_get: GET_CUR pan/tilt failed (0x%x)", kr]);
      return;
    }
    int16_t value = (prop == 0) ? pt.pan : pt.tilt;
    ok([NSString stringWithFormat:@",\"value\":%d,\"flags\":2", value]);
    return;
  }

  int32_t value = 0;
  IOReturn kr = uvcGetCur(g_session.usbDevice, sel, ent, &value, sizeof(value));
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"camctrl_get: GET_CUR failed (0x%x)", kr]);
    return;
  }
  ok([NSString stringWithFormat:@",\"value\":%d,\"flags\":2", value]);
}

// ---------------------------------------------------------------------------
// IAMVideoProcAmp equivalents
// ---------------------------------------------------------------------------

static void doProcAmpSet(NSString *propStr, NSString *valStr, NSString *flagsStr) {
  (void)flagsStr;
  if (!g_session.usbDevice) { err(@"procamp_set: no device open"); return; }
  long prop = [propStr integerValue];
  long value = [valStr integerValue];
  uint8_t sel = procampSel(prop);
  if (sel == 0) { err(@"procamp_set: unsupported property"); return; }

  int32_t v = (int32_t)value;
  IOReturn kr = uvcSetCur(g_session.usbDevice, sel, UVC_PU, &v, sizeof(v));
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"procamp_set: SET_CUR failed (0x%x)", kr]);
    return;
  }
  ok(@"");
}

static void doProcAmpRange(NSString *propStr) {
  if (!g_session.usbDevice) { err(@"procamp_range: no device open"); return; }
  long prop = [propStr integerValue];
  uint8_t sel = procampSel(prop);
  if (sel == 0) { err(@"procamp_range: unsupported property"); return; }

  int32_t min = 0, max = 0;
  IOReturn kr = uvcGetMin(g_session.usbDevice, sel, UVC_PU, &min, sizeof(min));
  if (kr == kIOReturnSuccess)
    kr = uvcGetMax(g_session.usbDevice, sel, UVC_PU, &max, sizeof(max));
  if (kr != kIOReturnSuccess) {
    err([NSString stringWithFormat:@"procamp_range: GET_MIN/MAX failed (0x%x)", kr]);
    return;
  }
  ok([NSString stringWithFormat:@",\"min\":%d,\"max\":%d", min, max]);
}

// ---------------------------------------------------------------------------
// Snapshot (AVFoundation photo capture)
// ---------------------------------------------------------------------------

static void doSnapshot(NSString *pathArg, long maxDim, long quality, long settleMs) {
  NSString *uid = (pathArg.length > 0) ? pathArg : g_session.devicePath;
  if (!uid || uid.length == 0) { err(@"snapshot: no device open and no path given"); return; }

  AVCaptureDevice *dev = [AVCaptureDevice deviceWithUniqueID:uid];
  if (!dev) { err([NSString stringWithFormat:@"snapshot: camera '%@' not found", uid]); return; }

  long actualSettle = (settleMs <= 0) ? 600 : settleMs;

  // All of this runs on the calling (main) thread and services the run loop
  // rather than blocking it. An earlier version wrapped the capture in
  // dispatch_sync + dispatch_semaphore_wait, which deadlocked every time:
  // AVFoundation delivers didFinishProcessingPhoto through the run loop, so a
  // blocked thread guarantees the callback never arrives and the wait always
  // hits its timeout.
  NSError *error = nil;
  AVCaptureSession *session = [[AVCaptureSession alloc] init];

  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:dev error:&error];
  if (!input) {
    err([NSString stringWithFormat:@"snapshot: %@", error.localizedDescription]);
    return;
  }
  if (![session canAddInput:input]) { err(@"snapshot: cannot add input"); return; }
  [session addInput:input];

  AVCapturePhotoOutput *output = [[AVCapturePhotoOutput alloc] init];
  if (![session canAddOutput:output]) { err(@"snapshot: cannot add photo output"); return; }
  [session addOutput:output];

  [session startRunning];

  // Let the stream settle (pump, don't sleep — same reason as above).
  pumpRunLoop((NSTimeInterval)actualSettle / 1000.0);

  SnapshotDelegate *delegate = [[SnapshotDelegate alloc] init];
  AVCapturePhotoSettings *settings = [AVCapturePhotoSettings photoSettingsWithFormat:@{
    AVVideoCodecKey: AVVideoCodecTypeJPEG,
  }];
  [output capturePhotoWithSettings:settings delegate:delegate];

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5.0];
  while (!delegate.done && [deadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                             beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }

  [session stopRunning];

  if (!delegate.done)     { err(@"snapshot: snapshot timed out"); return; }
  if (!delegate.jpegData) { err(@"snapshot: snapshot produced no data"); return; }

  // Scale if maxDim is specified.
  CGFloat w = delegate.dims.width;
  CGFloat h = delegate.dims.height;
  if (maxDim > 0 && (w > maxDim || h > maxDim)) {
    CGFloat scale = (CGFloat)maxDim / MAX(w, h);
    CGFloat dw = round(w * scale);
    CGFloat dh = round(h * scale);
    if (dw < 1) dw = 1;
    if (dh < 1) dh = 1;

    CGImageSourceRef src = CGImageSourceCreateWithData(
        (__bridge CFDataRef)delegate.jpegData, NULL);
    if (src) {
      NSDictionary *opts = @{
        (NSString *)kCGImageSourceThumbnailMaxPixelSize: @((CGFloat)maxDim),
        (NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
      };
      CGImageRef thumb = CGImageSourceCreateThumbnailAtIndex(src, 0,
          (__bridge CFDictionaryRef)opts);
      if (thumb) {
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:thumb];
        NSData *scaledJPEG = [rep representationUsingType:NSBitmapImageFileTypeJPEG
                                               properties:@{NSImageCompressionFactor: @((CGFloat)quality / 100.0)}];
        if (scaledJPEG) delegate.jpegData = scaledJPEG;
        CGImageRelease(thumb);
      }
      CFRelease(src);
    }
    w = dw; h = dh;
  }

  NSString *b64 = [delegate.jpegData base64EncodedStringWithOptions:0];
  ok([NSString stringWithFormat:
      @",\"mime\":\"image/jpeg\",\"width\":%ld,\"height\":%ld,\"base64\":\"%@\"",
      (long)w, (long)h, b64]);
}

// ---------------------------------------------------------------------------
// Main — stdio JSON-RPC dispatch
// ---------------------------------------------------------------------------

int main(int argc, const char *argv[]) {
  (void)argc; (void)argv;
  @autoreleasepool {
    NSFileHandle *stdinHandle = [NSFileHandle fileHandleWithStandardInput];

    atexit_b(^{ releaseSession(); });

    while (true) {
      @autoreleasepool {
        NSData *lineData = [stdinHandle availableData];
        if (lineData.length == 0) break;
        NSString *all = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
        if (!all || all.length == 0) continue;

        // NSFileHandle may return multiple lines in one chunk; split.
        NSArray *lines = [all componentsSeparatedByString:@"\n"];
        for (NSString *singleLine in lines) {
          NSString *trimmed = [singleLine stringByTrimmingCharactersInSet:
                                [NSCharacterSet whitespaceAndNewlineCharacterSet]];
          if (trimmed.length == 0) continue;

          @try {
            NSString *op = jsonField(trimmed, @"op");
            if (!op) { err(@"missing op"); continue; }

            if ([op isEqualToString:@"version"]) {
              doVersion();
            } else if ([op isEqualToString:@"enumerate"]) {
              doEnumerate();
            } else if ([op isEqualToString:@"open"]) {
              doOpen(jsonField(trimmed, @"path"));
            } else if ([op isEqualToString:@"xu_set"]) {
              doXuSet(jsonField(trimmed, @"selector"), jsonField(trimmed, @"hex"));
            } else if ([op isEqualToString:@"xu_get"]) {
              doXuGet(jsonField(trimmed, @"selector"), jsonField(trimmed, @"length"));
            } else if ([op isEqualToString:@"zoom_range"]) {
              doZoomRange();
            } else if ([op isEqualToString:@"zoom_set"]) {
              doZoomSet(jsonField(trimmed, @"units"));
            } else if ([op isEqualToString:@"camctrl_set"]) {
              doCamCtrlSet(jsonField(trimmed, @"property"),
                           jsonField(trimmed, @"value"),
                           jsonField(trimmed, @"flags"));
            } else if ([op isEqualToString:@"camctrl_range"]) {
              doCamCtrlRange(jsonField(trimmed, @"property"));
            } else if ([op isEqualToString:@"camctrl_get"]) {
              doCamCtrlGet(jsonField(trimmed, @"property"));
            } else if ([op isEqualToString:@"procamp_set"]) {
              doProcAmpSet(jsonField(trimmed, @"property"),
                           jsonField(trimmed, @"value"),
                           jsonField(trimmed, @"flags"));
            } else if ([op isEqualToString:@"procamp_range"]) {
              doProcAmpRange(jsonField(trimmed, @"property"));
            } else if ([op isEqualToString:@"snapshot"]) {
              doSnapshot(jsonField(trimmed, @"path"),
                         [jsonField(trimmed, @"maxDim") integerValue],
                         [jsonField(trimmed, @"quality") integerValue],
                         [jsonField(trimmed, @"settleMs") integerValue]);
            } else {
              err([NSString stringWithFormat:@"unknown op: %@", op]);
            }
          } @catch (NSException *e) {
            err([NSString stringWithFormat:@"exception: %@", e.reason]);
          }
        }
      }
    }
  }
  return 0;
}
