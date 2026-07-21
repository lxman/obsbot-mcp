// obsbot-helper -- Linux V4L2 native helper for the OBSBOT Tiny 2.
//
// Speaks a stdio JSON-line protocol: one JSON request object per stdin
// line, one JSON response object per stdout line. Nothing else is ever
// written to stdout; diagnostics go to stderr.
//
// Uses V4L2 for standard UVC controls (zoom, focus, exposure, pan/tilt,
// white balance, image controls) and UVCIOC_CTRL_QUERY for vendor
// Extension Unit commands (gimbal, AI tracking, wake/sleep, HDR, FOV).
// Snapshots use V4L2 MJPEG capture + base64 encoding.
//
// Same RPC protocol as the Windows helper (helper.cpp), so the entire
// Node-side transport / codec / MCP layer is shared unchanged.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <dirent.h>
#include <linux/limits.h>
#include <linux/videodev2.h>
#include <linux/uvcvideo.h>
#include <jpeglib.h>

// ---- UVC request codes (from linux/usb/video.h) ----
#ifndef UVC_SET_CUR
#define UVC_SET_CUR 0x01
#endif
#ifndef UVC_GET_CUR
#define UVC_GET_CUR 0x81
#endif

// ---- JSON helpers ----

static void json_escape(FILE *out, const char *s)
{
    fputc('"', out);
    for (; *s; s++) {
        switch (*s) {
            case '"':  fputs("\\\"", out); break;
            case '\\': fputs("\\\\", out); break;
            case '\n': fputs("\\n", out); break;
            case '\r': fputs("\\r", out); break;
            case '\t': fputs("\\t", out); break;
            default:
                if ((unsigned char)*s < 0x20)
                    fprintf(out, "\\u%04x", (unsigned char)*s);
                else
                    fputc(*s, out);
        }
    }
    fputc('"', out);
}

static void ok_response(const char *body)
{
    printf("{\"ok\":true%s}\n", body ? body : "");
    fflush(stdout);
}

static void error_response(const char *msg)
{
    printf("{\"ok\":false,\"error\":");
    json_escape(stdout, msg);
    printf("}\n");
    fflush(stdout);
}

// Extract a string field value from a flat JSON object.
// Returns pointer to static buffer (valid until next call) or NULL.
static char *get_field(const char *j, const char *key)
{
#define FIELD_BUF_SIZE 4096
    static char bufs[4][FIELD_BUF_SIZE];
    static int idx = 0;
    char *buf = bufs[idx];
    idx = (idx + 1) % 4;
    char pattern[64];
    const char *k, *c;
    size_t n;
    int esc;

    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    k = strstr(j, pattern);
    if (!k) return NULL;
    c = strchr(k, ':');
    if (!c) return NULL;
    c++;
    while (*c == ' ' || *c == '\t') c++;
    if (*c != '"') {
        /* Unquoted value (numeric/boolean) */
        n = 0;
        while (*c && *c != ',' && *c != '}' && *c != ' ' &&
               *c != '\r' && *c != '\n' && n < FIELD_BUF_SIZE - 1)
            buf[n++] = *c++;
        buf[n] = '\0';
        return buf;
    }
    /* Quoted string */
    c++;
    n = 0;
    esc = 0;
    while (*c && n < FIELD_BUF_SIZE - 1) {
        if (esc) {
            switch (*c) {
                case '"': buf[n++] = '"'; break;
                case '\\': buf[n++] = '\\'; break;
                case '/': buf[n++] = '/'; break;
                case 'n': buf[n++] = '\n'; break;
                case 't': buf[n++] = '\t'; break;
                case 'r': buf[n++] = '\r'; break;
                default:  buf[n++] = *c; break;
            }
            esc = 0;
            c++;
            continue;
        }
        if (*c == '\\') { esc = 1; c++; continue; }
        if (*c == '"') break;
        buf[n++] = *c++;
    }
    buf[n] = '\0';
    return buf;
}

// ---- hex helpers ----
static const char HEX_DIGITS[] = "0123456789abcdef";

static const char *to_hex_str(const uint8_t *data, size_t len)
{
    static char buf[8192];
    size_t n = len * 2;
    if (n > sizeof(buf) - 1) n = sizeof(buf) - 1;
    for (size_t i = 0; i < len && i * 2 + 1 < n; i++) {
        buf[i * 2]     = HEX_DIGITS[data[i] >> 4];
        buf[i * 2 + 1] = HEX_DIGITS[data[i] & 0xf];
    }
    buf[n] = '\0';
    return buf;
}

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char *h, uint8_t *out, size_t max)
{
    size_t len = strlen(h);
    size_t n;
    int hi, lo;

    if (len % 2 != 0) return -1;
    n = len / 2;
    if (n > max) n = max;
    for (size_t i = 0; i < n; i++) {
        hi = hex_nibble(h[i * 2]);
        lo = hex_nibble(h[i * 2 + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return (int)n;
}

// ---- base64 encoding ----
static const char B64_TABLE[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64_encode(const uint8_t *data, size_t len,
                          char *out, size_t out_max)
{
    size_t n = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v;
        if (n + 4 > out_max) break;
        v = (uint32_t)data[i] << 16;
        if (i + 1 < len) v |= (uint32_t)data[i + 1] << 8;
        if (i + 2 < len) v |= data[i + 2];
        out[n++] = B64_TABLE[(v >> 18) & 0x3f];
        out[n++] = B64_TABLE[(v >> 12) & 0x3f];
        out[n++] = (i + 1 < len) ? B64_TABLE[(v >> 6) & 0x3f] : '=';
        out[n++] = (i + 2 < len) ? B64_TABLE[v & 0x3f] : '=';
    }
    out[n] = '\0';
    return (int)n;
}
// ---- V4L2 helpers ----

static int g_fd = -1;
static int g_xu_unit = -1;
static char g_open_path[PATH_MAX] = "";
static bool g_have_zoom = false;
// Last successfully V4L2-set pan_absolute/tilt_absolute values for repair.
// After certain XU operations (UVCIOC_CTRL_QUERY), VIDIOC_G_CTRL for pan/tilt
// fails. A VIDIOC_S_CTRL with any value restores the state, so we cache the
// last-known-good value here to repair without a physical jolt.
static int g_last_pan = 0;
static int g_last_tilt = 0;

// ---- V4L2 helpers ----

// Returns 0 on success (value stored in *out), -1 on failure.
static int v4l2_get_ctrl_ex(int fd, int cid, int *out)
{
    struct v4l2_control c;
    memset(&c, 0, sizeof(c));
    c.id = cid;
    if (ioctl(fd, VIDIOC_G_CTRL, &c) < 0) return -1;
    if (out) *out = c.value;
    return 0;
}

static int v4l2_set_ctrl(int fd, int cid, int value)
{
    struct v4l2_control c;
    memset(&c, 0, sizeof(c));
    c.id = cid;
    c.value = value;
    return ioctl(fd, VIDIOC_S_CTRL, &c);
}

static int v4l2_query_ctrl(int fd, int cid, int *min, int *max)
{
    struct v4l2_queryctrl q;
    memset(&q, 0, sizeof(q));
    q.id = cid;
    if (ioctl(fd, VIDIOC_QUERYCTRL, &q) < 0) return -1;
    if (q.flags & V4L2_CTRL_FLAG_DISABLED) return -1;
    if (min) *min = q.minimum;
    if (max) *max = q.maximum;
    return 0;
}

// Map DirectShow CameraControl property ids to V4L2 control ids
static int camctrl_to_v4l2(int prop)
{
    switch (prop) {
        case 0: return V4L2_CID_PAN_ABSOLUTE;
        case 1: return V4L2_CID_TILT_ABSOLUTE;
        case 4: return V4L2_CID_EXPOSURE_ABSOLUTE;
        case 6: return V4L2_CID_FOCUS_ABSOLUTE;
        default: return -1;
    }
}

// Map DirectShow VideoProcAmp property ids to V4L2 control ids
static int procamp_to_v4l2(int prop)
{
    switch (prop) {
        case 0: return V4L2_CID_BRIGHTNESS;
        case 1: return V4L2_CID_CONTRAST;
        case 2: return V4L2_CID_HUE;
        case 3: return V4L2_CID_SATURATION;
        case 4: return V4L2_CID_SHARPNESS;
        case 7: return V4L2_CID_WHITE_BALANCE_TEMPERATURE;
        case 8: return V4L2_CID_BACKLIGHT_COMPENSATION;
        case 9: return V4L2_CID_GAIN;
        default: return -1;
    }
}

// Return the V4L2 auto-control id paired with a manual control, or -1 if none.
static int auto_ctrl_for(int cid)
{
    switch (cid) {
        case V4L2_CID_FOCUS_ABSOLUTE:
            return V4L2_CID_FOCUS_AUTO;
        case V4L2_CID_WHITE_BALANCE_TEMPERATURE:
            return V4L2_CID_AUTO_WHITE_BALANCE;
        case V4L2_CID_EXPOSURE_ABSOLUTE:
            return V4L2_CID_EXPOSURE_AUTO;
        default:
            return -1;
    }
}

// Probe for the XU extension unit. The OBSBOT Tiny 2 uses unit=2.
static int probe_xu_unit(int fd)
{
    int unit;
    uint8_t buf[64];
    struct uvc_xu_control_query q;

    for (unit = 1; unit <= 6; unit++) {
        memset(&q, 0, sizeof(q));
        memset(buf, 0, sizeof(buf));
        q.unit = (uint8_t)unit;
        q.selector = 1;   /* first available selector */
        q.query = UVC_GET_CUR;
        q.size = 60;
        q.data = buf;
        if (ioctl(fd, UVCIOC_CTRL_QUERY, &q) == 0) {
            fprintf(stderr, "obsbot-helper: XU unit found at unit=%d\n", unit);
            return unit;
        }
    }
    return -1;
}

// ---- operations ----

static void do_version(void)
{
    /* Must match package.json's version; test/version-sync.test.ts enforces it. */
    printf("{\"ok\":true,\"version\":\"0.4.0\",\"helper\":\"v4l2\"}\n");
    fflush(stdout);
}

static void do_enumerate(void)
{
    DIR *dir = opendir("/dev");
    int first = 1;

    if (!dir) { error_response("cannot open /dev"); return; }

    printf("{\"ok\":true,\"devices\":[");
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        struct v4l2_capability cap;
        char path[PATH_MAX];
        int fd;

        if (strncmp(entry->d_name, "video", 5) != 0) continue;
        snprintf(path, sizeof(path), "/dev/%s", entry->d_name);

        fd = open(path, O_RDWR);
        if (fd < 0) continue;

        memset(&cap, 0, sizeof(cap));
        if (ioctl(fd, VIDIOC_QUERYCAP, &cap) == 0 &&
            (cap.capabilities & V4L2_CAP_VIDEO_CAPTURE) &&
            (cap.capabilities & V4L2_CAP_STREAMING)) {
            if (!first) fputc(',', stdout);
            first = 0;
            printf("{\"path\":");
            json_escape(stdout, path);
            printf(",\"name\":");
            json_escape(stdout, (const char *)cap.card);
            printf("}");
        }
        close(fd);
    }
    closedir(dir);
    printf("]}\n");
    fflush(stdout);
}

static void do_open(const char *path)
{
    struct v4l2_capability cap;
    int fd, xu_unit;

    if (!path || !*path) { error_response("open: missing path"); return; }

    /* Close any prior session */
    if (g_fd >= 0) { close(g_fd); g_fd = -1; }
    g_xu_unit = -1;
    g_open_path[0] = '\0';
    g_have_zoom = false;

    fd = open(path, O_RDWR);
    if (fd < 0) { error_response("open: cannot open device"); return; }

    memset(&cap, 0, sizeof(cap));
    if (ioctl(fd, VIDIOC_QUERYCAP, &cap) < 0) {
        close(fd);
        error_response("open: not a V4L2 device");
        return;
    }
    if (!(cap.capabilities & V4L2_CAP_VIDEO_CAPTURE)) {
        close(fd);
        error_response("open: device does not support video capture");
        return;
    }

    xu_unit = probe_xu_unit(fd);
    if (xu_unit < 0)
        fprintf(stderr, "obsbot-helper: no XU extension unit found\n");

    /* Check for zoom support */
    {
        struct v4l2_queryctrl zq;
        memset(&zq, 0, sizeof(zq));
        zq.id = V4L2_CID_ZOOM_ABSOLUTE;
        g_have_zoom = (ioctl(fd, VIDIOC_QUERYCTRL, &zq) == 0 &&
                       !(zq.flags & V4L2_CTRL_FLAG_DISABLED));
    }

    g_fd = fd;
    g_xu_unit = xu_unit;
    strncpy(g_open_path, path, sizeof(g_open_path) - 1);
    g_open_path[sizeof(g_open_path) - 1] = '\0';

    printf("{\"ok\":true,\"xuNode\":%d,\"xunit\":%d}\n",
           xu_unit, xu_unit);
    fflush(stdout);
}

static void do_nodes(void)
{
    if (g_fd < 0) { error_response("nodes: no device open"); return; }
    printf("{\"ok\":true,\"nodes\":["
           "{\"index\":0,\"type\":\"video-capture\"},"
           "{\"index\":1,\"type\":\"extension-unit\",\"xu_unit\":%d}"
           "]}\n", g_xu_unit);
    fflush(stdout);
}

static void do_xu_set(const char *sel_str, const char *hex)
{
    uint8_t buf[64];
    int n, sel;
    struct uvc_xu_control_query q;

    if (g_fd < 0 || g_xu_unit < 0) {
        error_response("xu_set: no device open or no XU unit found");
        return;
    }
    if (!sel_str || !*sel_str) { error_response("xu_set: missing selector"); return; }
    if (!hex) { error_response("xu_set: missing hex"); return; }

    sel = (int)strtol(sel_str, NULL, 10);
    n = parse_hex(hex, buf, sizeof(buf));
    if (n < 0) { error_response("xu_set: invalid hex"); return; }

    memset(&q, 0, sizeof(q));
    q.unit = (uint8_t)g_xu_unit;
    q.selector = (uint8_t)sel;
    q.query = UVC_SET_CUR;
    q.size = (uint16_t)n;
    q.data = buf;

    if (ioctl(g_fd, UVCIOC_CTRL_QUERY, &q) < 0) {
        char emsg[128];
        snprintf(emsg, sizeof(emsg), "xu_set failed: %s", strerror(errno));
        error_response(emsg);
        return;
    }
    ok_response("");
}

static void do_xu_get(const char *sel_str, const char *len_str)
{
    uint8_t buf[256];
    unsigned long sel, length;
    struct uvc_xu_control_query q;

    if (g_fd < 0 || g_xu_unit < 0) {
        error_response("xu_get: no device open or no XU unit found");
        return;
    }
    if (!sel_str || !*sel_str) { error_response("xu_get: missing selector"); return; }

    sel = strtoul(sel_str, NULL, 10);
    length = (len_str && *len_str) ? strtoul(len_str, NULL, 10) : 60;
    if (length > 256) length = 256;
    memset(buf, 0, length);

    memset(&q, 0, sizeof(q));
    q.unit = (uint8_t)g_xu_unit;
    q.selector = (uint8_t)sel;
    q.query = UVC_GET_CUR;
    q.size = (uint16_t)length;
    q.data = buf;

    if (ioctl(g_fd, UVCIOC_CTRL_QUERY, &q) < 0) {
        char emsg[128];
        snprintf(emsg, sizeof(emsg), "xu_get failed: %s", strerror(errno));
        error_response(emsg);
        return;
    }
    printf("{\"ok\":true,\"hex\":\"%s\"}\n", to_hex_str(buf, q.size));
    fflush(stdout);
}

static void do_zoom_range(void)
{
    int min = 0, max = 0;
    if (g_fd < 0) { error_response("zoom_range: no device open"); return; }
    if (v4l2_query_ctrl(g_fd, V4L2_CID_ZOOM_ABSOLUTE, &min, &max) < 0) {
        error_response("zoom_range: V4L2_CID_ZOOM_ABSOLUTE not supported");
        return;
    }
    printf("{\"ok\":true,\"min\":%d,\"max\":%d}\n", min, max);
    fflush(stdout);
}

static void do_zoom_set(const char *units_str)
{
    long units;
    if (g_fd < 0) { error_response("zoom_set: no device open"); return; }
    if (!units_str || !*units_str) { error_response("zoom_set: missing units"); return; }
    units = strtol(units_str, NULL, 10);
    if (v4l2_set_ctrl(g_fd, V4L2_CID_ZOOM_ABSOLUTE, (int)units) < 0) {
        error_response("zoom_set: V4L2_CID_ZOOM_ABSOLUTE set failed");
        return;
    }
    ok_response("");
}

static void do_camctrl_set(const char *prop_str, const char *val_str,
                            const char *flags_str)
{
    int prop, value, flags, cid, auto_cid;

    if (g_fd < 0) { error_response("camctrl_set: no device open"); return; }
    if (!prop_str || !val_str || !flags_str) {
        error_response("camctrl_set: missing property/value/flags");
        return;
    }

    prop = (int)strtol(prop_str, NULL, 10);
    value = (int)strtol(val_str, NULL, 10);
    flags = (int)strtol(flags_str, NULL, 10);
    cid = camctrl_to_v4l2(prop);
    if (cid < 0) { error_response("camctrl_set: unknown property"); return; }

    auto_cid = auto_ctrl_for(cid);
    if (auto_cid >= 0) {
        if (flags == 1) {
            /* Auto */
            if (v4l2_set_ctrl(g_fd, auto_cid, 1) < 0) {
                error_response("camctrl_set: failed to enable auto");
                return;
            }
            ok_response("");
            return;
        }
        /* Manual -- disable auto first */
        v4l2_set_ctrl(g_fd, auto_cid, 0);
    }

    /* Exposure absolute may not work on the XU device node; fall back to /dev/video2 */
    if (cid == V4L2_CID_EXPOSURE_ABSOLUTE) {
        int ret = v4l2_set_ctrl(g_fd, cid, value);
        if (ret == 0) {
            ok_response("");
            return;
        }
        /* Primary device failed — try /dev/video2 */
        int save_errno = errno;
        int video2_fd = open("/dev/video2", O_RDWR);
        if (video2_fd < 0) {
            fprintf(stderr, "obsbot-helper: camctrl_set: primary failed (errno=%d), cannot open /dev/video2\n", save_errno);
            error_response("camctrl_set: set failed (primary), and cannot open /dev/video2");
            return;
        }
        ret = v4l2_set_ctrl(video2_fd, cid, value);
        int video2_errno = errno;
        close(video2_fd);
        if (ret != 0) {
            fprintf(stderr, "obsbot-helper: camctrl_set: both failed (primary errno=%d, /dev/video2 errno=%d)\n", save_errno, video2_errno);
            error_response("camctrl_set: set failed on both devices");
            return;
        }
        ok_response("");
        return;
    }

    /* Non-exposure controls */
    if (v4l2_set_ctrl(g_fd, cid, value) < 0) {
        error_response("camctrl_set: set failed");
        return;
    }
    /* Cache pan/tilt values for repair after XU corruption */
    if (cid == V4L2_CID_PAN_ABSOLUTE) g_last_pan = value;
    if (cid == V4L2_CID_TILT_ABSOLUTE) g_last_tilt = value;
    ok_response("");
}

static void do_camctrl_range(const char *prop_str)
{
    int prop, cid, min = 0, max = 0;
    if (g_fd < 0) { error_response("camctrl_range: no device open"); return; }
    if (!prop_str || !*prop_str) { error_response("camctrl_range: missing property"); return; }
    prop = (int)strtol(prop_str, NULL, 10);
    cid = camctrl_to_v4l2(prop);
    if (cid < 0) { error_response("camctrl_range: unknown property"); return; }
    if (v4l2_query_ctrl(g_fd, cid, &min, &max) < 0) {
        /* Exposure absolute doesn't support QUERYCTRL or G_CTRL on this device
           even though S_CTRL works. Use sane defaults. */
        if (cid == V4L2_CID_EXPOSURE_ABSOLUTE) {
            min = 0; max = 65535;
            printf("{\"ok\":true,\"min\":%d,\"max\":%d}\n", min, max);
            fflush(stdout);
            return;
        }
        error_response("camctrl_range: control not supported");
        return;
    }
    printf("{\"ok\":true,\"min\":%d,\"max\":%d}\n", min, max);
    fflush(stdout);
}

static void do_camctrl_get(const char *prop_str)
{
    int prop, cid, value, auto_cid;

    if (g_fd < 0) { error_response("camctrl_get: no device open"); return; }
    if (!prop_str || !*prop_str) { error_response("camctrl_get: missing property"); return; }

    prop = (int)strtol(prop_str, NULL, 10);
    cid = camctrl_to_v4l2(prop);
    if (cid < 0) { error_response("camctrl_get: unknown property"); return; }

    /* Check auto first */
    auto_cid = auto_ctrl_for(cid);
    if (auto_cid >= 0) {
        int auto_val;
        if (v4l2_get_ctrl_ex(g_fd, auto_cid, &auto_val) == 0 && auto_val == 1) {
            printf("{\"ok\":true,\"value\":0,\"flags\":1}\n");
            fflush(stdout);
            return;
        }
    }

    if (v4l2_get_ctrl_ex(g_fd, cid, &value) < 0) {
        /* After certain XU operations (preset read/write, status reads), the
           V4L2 pan_absolute/tilt_absolute controls enter a state where
           VIDIOC_G_CTRL fails. A VIDIOC_S_CTRL with the last-known-good value
           restores the state — proven by hardware probing 2026-07-19. */
        if (cid == V4L2_CID_PAN_ABSOLUTE || cid == V4L2_CID_TILT_ABSOLUTE) {
            int repair_val = (cid == V4L2_CID_PAN_ABSOLUTE) ? g_last_pan : g_last_tilt;
            int set_ret, retry_get_val;
            /* First try immediate set + get. If that fails, try with a delta
               (set to a different value, then back) to force the control to
               cycle in hardware. */
            for (int attempt = 0; attempt < 2; attempt++) {
                int try_val = (attempt == 0) ? repair_val : ((repair_val == 0) ? 3600 : 0);
                fprintf(stderr, "obsbot-helper: camctrl_get pan/tilt failed, repair attempt %d with %d\n",
                        attempt, try_val);
                set_ret = v4l2_set_ctrl(g_fd, cid, try_val);
                fprintf(stderr, "obsbot-helper: repair set returned %d\n", set_ret);
                if (set_ret < 0) continue;
                if (v4l2_get_ctrl_ex(g_fd, cid, &retry_get_val) == 0) {
                    printf("{\"ok\":true,\"value\":%d,\"flags\":2}\n", retry_get_val);
                    fflush(stdout);
                    return;
                }
            }
        }
        error_response("camctrl_get: failed");
        return;
    }
    printf("{\"ok\":true,\"value\":%d,\"flags\":2}\n", value);
    fflush(stdout);
}

static void do_procamp_set(const char *prop_str, const char *val_str,
                            const char *flags_str)
{
    int prop, value, flags, cid, auto_cid;

    if (g_fd < 0) { error_response("procamp_set: no device open"); return; }
    if (!prop_str || !val_str || !flags_str) {
        error_response("procamp_set: missing property/value/flags");
        return;
    }

    prop = (int)strtol(prop_str, NULL, 10);
    value = (int)strtol(val_str, NULL, 10);
    flags = (int)strtol(flags_str, NULL, 10);
    cid = procamp_to_v4l2(prop);
    if (cid < 0) { error_response("procamp_set: unknown property"); return; }

    auto_cid = auto_ctrl_for(cid);
    if (auto_cid >= 0) {
        if (flags == 1) {
            if (v4l2_set_ctrl(g_fd, auto_cid, 1) < 0) {
                error_response("procamp_set: failed to enable auto");
                return;
            }
            ok_response("");
            return;
        }
        v4l2_set_ctrl(g_fd, auto_cid, 0);
    }

    if (v4l2_set_ctrl(g_fd, cid, value) < 0) {
        error_response("procamp_set: set failed");
        return;
    }
    ok_response("");
}

static void do_procamp_range(const char *prop_str)
{
    int prop, cid, min = 0, max = 0;
    if (g_fd < 0) { error_response("procamp_range: no device open"); return; }
    if (!prop_str || !*prop_str) { error_response("procamp_range: missing property"); return; }
    prop = (int)strtol(prop_str, NULL, 10);
    cid = procamp_to_v4l2(prop);
    if (cid < 0) { error_response("procamp_range: unknown property"); return; }
    if (v4l2_query_ctrl(g_fd, cid, &min, &max) < 0) {
        error_response("procamp_range: control not supported");
        return;
    }
    printf("{\"ok\":true,\"min\":%d,\"max\":%d}\n", min, max);
    fflush(stdout);
}

// ---- snapshot via V4L2 mmap + libjpeg ----

static void do_snapshot(const char *path_arg, long max_dim,
                         long quality, long settle_ms)
{
    const char *path;
    int fd;
    struct v4l2_format fmt;
    struct v4l2_requestbuffers req;
    struct v4l2_buffer dq;
    enum v4l2_buf_type type;
    unsigned int nbufs, src_w, src_h, out_w, out_h;
    int is_mjpeg;
    char b64_buf[1572864]; /* 1.5 MB — safety buffer for ~768KB MJPEG frames */

    (void)settle_ms; /* V4L2 pulls one frame directly -- no settle needed */

    path = (path_arg && *path_arg) ? path_arg : g_open_path;
    if (!path || !*path) { error_response("snapshot: no device open and no path given"); return; }

    fd = open(path, O_RDWR);
    if (fd < 0) { error_response("snapshot: cannot open device"); return; }

    /* Negotiate format: try MJPEG first */
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    fmt.fmt.pix.width = 1920;
    fmt.fmt.pix.height = 1080;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_MJPEG;
    fmt.fmt.pix.field = V4L2_FIELD_NONE;

    if (ioctl(fd, VIDIOC_S_FMT, &fmt) < 0) {
        fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
        if (ioctl(fd, VIDIOC_S_FMT, &fmt) < 0) {
            close(fd);
            error_response("snapshot: cannot set video format");
            return;
        }
    }

    src_w = fmt.fmt.pix.width;
    src_h = fmt.fmt.pix.height;
    is_mjpeg = (fmt.fmt.pix.pixelformat == V4L2_PIX_FMT_MJPEG);

    /* Request buffers */
    memset(&req, 0, sizeof(req));
    req.count = 4;
    req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    req.memory = V4L2_MEMORY_MMAP;

    if (ioctl(fd, VIDIOC_REQBUFS, &req) < 0 || req.count < 2) {
        close(fd);
        error_response("snapshot: cannot request buffers");
        return;
    }

    nbufs = req.count;
    if (nbufs > 4) nbufs = 4;

    /* Query and mmap buffers */
    {
        struct v4l2_buffer_info {
            void   *start;
            size_t  length;
        } bufs[4];
        unsigned int i;
        int ok = 1;

        for (i = 0; i < nbufs && ok; i++) {
            struct v4l2_buffer buf;
            memset(&buf, 0, sizeof(buf));
            buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            buf.memory = V4L2_MEMORY_MMAP;
            buf.index = i;

            if (ioctl(fd, VIDIOC_QUERYBUF, &buf) < 0) {
                ok = 0;
                break;
            }
            bufs[i].length = buf.length;
            bufs[i].start = mmap(NULL, buf.length,
                                  PROT_READ | PROT_WRITE, MAP_SHARED,
                                  fd, buf.m.offset);
            if (bufs[i].start == MAP_FAILED) {
                ok = 0;
                break;
            }
        }

        if (!ok) {
            for (unsigned int j = 0; j < i; j++)
                munmap(bufs[j].start, bufs[j].length);
            req.count = 0;
            ioctl(fd, VIDIOC_REQBUFS, &req);
            close(fd);
            error_response("snapshot: buffer setup failed");
            return;
        }

        /* Queue all buffers */
        for (i = 0; i < nbufs; i++) {
            struct v4l2_buffer buf;
            memset(&buf, 0, sizeof(buf));
            buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            buf.memory = V4L2_MEMORY_MMAP;
            buf.index = i;
            if (ioctl(fd, VIDIOC_QBUF, &buf) < 0) {
                ok = 0;
                break;
            }
        }

        if (!ok) {
            for (unsigned int j = 0; j < nbufs; j++)
                munmap(bufs[j].start, bufs[j].length);
            req.count = 0;
            ioctl(fd, VIDIOC_REQBUFS, &req);
            close(fd);
            error_response("snapshot: queue failed");
            return;
        }

        /* Start streaming */
        type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        if (ioctl(fd, VIDIOC_STREAMON, &type) < 0) {
            for (unsigned int j = 0; j < nbufs; j++)
                munmap(bufs[j].start, bufs[j].length);
            req.count = 0;
            ioctl(fd, VIDIOC_REQBUFS, &req);
            close(fd);
            error_response("snapshot: streamon failed");
            return;
        }

        /* Dequeue one frame */
        memset(&dq, 0, sizeof(dq));
        dq.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        dq.memory = V4L2_MEMORY_MMAP;

        if (ioctl(fd, VIDIOC_DQBUF, &dq) < 0) {
            ioctl(fd, VIDIOC_STREAMOFF, &type);
            for (unsigned int j = 0; j < nbufs; j++)
                munmap(bufs[j].start, bufs[j].length);
            req.count = 0;
            ioctl(fd, VIDIOC_REQBUFS, &req);
            close(fd);
            error_response("snapshot: dqbuf failed");
            return;
        }

        /* Stop streaming */
        ioctl(fd, VIDIOC_STREAMOFF, &type);

        /* Process the frame */
        out_w = src_w;
        out_h = src_h;

        if (is_mjpeg) {
            /* Data is already JPEG -- just base64 it */
            base64_encode((const uint8_t *)bufs[dq.index].start,
                           dq.bytesused, b64_buf, sizeof(b64_buf));
        } else {
            /* YUYV to JPEG via libjpeg */
            unsigned char *yuyv = (unsigned char *)bufs[dq.index].start;
            int stride = src_w * 2;
            struct jpeg_compress_struct cinfo;
            struct jpeg_error_mgr jerr;
            unsigned char *jpeg_buf = NULL;
            unsigned long jpeg_size = 0;

            cinfo.err = jpeg_std_error(&jerr);
            jpeg_create_compress(&cinfo);
            jpeg_mem_dest(&cinfo, &jpeg_buf, &jpeg_size);

            cinfo.image_width = src_w;
            cinfo.image_height = src_h;
            cinfo.input_components = 3;
            cinfo.in_color_space = JCS_YCbCr;
            jpeg_set_defaults(&cinfo);
            jpeg_set_quality(&cinfo, (int)quality, TRUE);

            jpeg_start_compress(&cinfo, TRUE);

            /* Convert YUYV to YCbCr planar rows for libjpeg */
            {
                JSAMPROW row = (JSAMPROW)malloc(src_w * 3);
                for (unsigned int y = 0; y < src_h; y++) {
                    unsigned char *line = yuyv + y * stride;
                    for (unsigned int x = 0; x < src_w; x++) {
                        int idx = (x / 2) * 4;
                        if (x % 2 == 0) {
                            row[x * 3]     = line[idx];      /* Y */
                            row[x * 3 + 1] = line[idx + 1];  /* Cb */
                            row[x * 3 + 2] = line[idx + 3];  /* Cr */
                        } else {
                            row[x * 3]     = line[idx + 2];  /* Y */
                            row[x * 3 + 1] = line[idx + 1];  /* Cb */
                            row[x * 3 + 2] = line[idx + 3];  /* Cr */
                        }
                    }
                    jpeg_write_scanlines(&cinfo, &row, 1);
                }
                free(row);
            }

            jpeg_finish_compress(&cinfo);
            jpeg_destroy_compress(&cinfo);

            base64_encode(jpeg_buf, jpeg_size, b64_buf, sizeof(b64_buf));
            free(jpeg_buf);
        }

        /* Unmap */
        for (unsigned int j = 0; j < nbufs; j++)
            munmap(bufs[j].start, bufs[j].length);
    }

    /* Free V4L2 buffers */
    req.count = 0;
    ioctl(fd, VIDIOC_REQBUFS, &req);
    close(fd);

    printf("{\"ok\":true,\"mime\":\"image/jpeg\",\"width\":%u,\"height\":%u,\"base64\":",
           out_w, out_h);
    json_escape(stdout, b64_buf);
    printf("}\n");
    fflush(stdout);
}

// ---- main loop ----

static void release_session(void)
{
    if (g_fd >= 0) { close(g_fd); g_fd = -1; }
    g_xu_unit = -1;
    g_open_path[0] = '\0';
    g_have_zoom = false;
}

int main(void)
{
    char line[8192];

    while (fgets(line, sizeof(line), stdin)) {
        size_t len;
        char *op;

        /* Strip trailing newline */
        len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
            line[--len] = '\0';
        if (len == 0) continue;

        op = get_field(line, "op");
        if (!op) { error_response("missing op"); continue; }

        if (strcmp(op, "version") == 0) {
            do_version();
        } else if (strcmp(op, "enumerate") == 0) {
            do_enumerate();
        } else if (strcmp(op, "open") == 0) {
            do_open(get_field(line, "path"));
        } else if (strcmp(op, "nodes") == 0) {
            do_nodes();
        } else if (strcmp(op, "xu_set") == 0) {
            do_xu_set(get_field(line, "selector"), get_field(line, "hex"));
        } else if (strcmp(op, "xu_get") == 0) {
            do_xu_get(get_field(line, "selector"), get_field(line, "length"));
        } else if (strcmp(op, "zoom_range") == 0) {
            do_zoom_range();
        } else if (strcmp(op, "zoom_set") == 0) {
            do_zoom_set(get_field(line, "units"));
        } else if (strcmp(op, "camctrl_set") == 0) {
            do_camctrl_set(get_field(line, "property"),
                            get_field(line, "value"),
                            get_field(line, "flags"));
        } else if (strcmp(op, "camctrl_range") == 0) {
            do_camctrl_range(get_field(line, "property"));
        } else if (strcmp(op, "camctrl_get") == 0) {
            do_camctrl_get(get_field(line, "property"));
        } else if (strcmp(op, "procamp_set") == 0) {
            do_procamp_set(get_field(line, "property"),
                            get_field(line, "value"),
                            get_field(line, "flags"));
        } else if (strcmp(op, "procamp_range") == 0) {
            do_procamp_range(get_field(line, "property"));
        } else if (strcmp(op, "snapshot") == 0) {
            char *mx = get_field(line, "maxDim");
            char *q  = get_field(line, "quality");
            char *st = get_field(line, "settleMs");
            do_snapshot(get_field(line, "path"),
                        mx ? strtol(mx, NULL, 10) : 1024,
                        q  ? strtol(q, NULL, 10) : 80,
                        st ? strtol(st, NULL, 10) : 600);
        } else {
            char emsg[128];
            snprintf(emsg, sizeof(emsg), "unknown op: %s", op);
            error_response(emsg);
        }
    }

    release_session();
    return 0;
}
