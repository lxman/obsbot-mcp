// unique_id.h — does an AVFoundation uniqueID name this USB device?
//
// The helper is handed a camera as an AVFoundation uniqueID and has to find
// the USB device behind it. Getting that wrong means opening, and then writing
// vendor commands to, a camera other than the one that was asked for — and the
// camera next to a Tiny 2 may be a Tail 2, which must never be sent one.
//
// macOS builds a UVC camera's uniqueID as
//     "0x" + locationID (hex, no leading zeros) + VID (4 hex) + PID (4 hex)
// Verified on hardware: location 0x3120000, 3564:fef8 → "0x31200003564fef8";
// location 0x2212000, 3564:fefc → "0x22120003564fefc".
//
// Plain C with no Apple headers, so the rule can be compiled and tested on its
// own (native/macos/unique_id_test.c, run by test/native/unique-id.test.ts).

#ifndef OBSBOT_UNIQUE_ID_H
#define OBSBOT_UNIQUE_ID_H

#include <ctype.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static inline bool obsbot_contains_nocase(const char *haystack, const char *needle) {
  size_t n = strlen(needle);
  if (n == 0) return true;
  for (; *haystack; haystack++) {
    size_t i = 0;
    while (i < n && haystack[i] &&
           tolower((unsigned char)haystack[i]) == tolower((unsigned char)needle[i])) i++;
    if (i == n) return true;
  }
  return false;
}

static inline bool obsbot_hex(const char *s, size_t n, uint32_t *out) {
  uint32_t v = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char ch = (unsigned char)s[i];
    if (!isxdigit(ch)) return false;
    v = (v << 4) | (uint32_t)(isdigit(ch) ? ch - '0' : tolower(ch) - 'a' + 10);
  }
  *out = v;
  return true;
}

/**
 * Split a uniqueID of the known form into its three parts. False if `uid` is
 * not of that form: no "0x", something that is not hex, or a length that
 * cannot be a 32-bit location followed by two 16-bit ids.
 */
static inline bool obsbot_parse_unique_id(const char *uid, uint32_t *loc, uint16_t *vid,
                                          uint16_t *pid) {
  if (!uid || uid[0] != '0' || (uid[1] != 'x' && uid[1] != 'X')) return false;
  const char *hex = uid + 2;
  size_t n = strlen(hex);
  if (n < 9 || n > 16) return false; // 1–8 digits of location, then 4 + 4
  uint32_t l, v, p;
  if (!obsbot_hex(hex, n - 8, &l) || !obsbot_hex(hex + n - 8, 4, &v) ||
      !obsbot_hex(hex + n - 4, 4, &p)) {
    return false;
  }
  *loc = l;
  *vid = (uint16_t)v;
  *pid = (uint16_t)p;
  return true;
}

/**
 * Does `uid` name the USB device at `loc` with these ids?
 *
 * In the known form, all three parts must be equal. There is no looser match
 * for a uniqueID that parses: "contains the location" is how a Tiny 2 at
 * 0x1100000 came to match a camera at 0x100000.
 *
 * A uniqueID that does NOT parse may be a form from a macOS release this code
 * has not met. It is matched only to a device whose vendor+product and whose
 * location both appear in it — so it can be loose about position, and still
 * cannot cross from one model to another.
 */
static inline bool obsbot_unique_id_names(const char *uid, uint32_t loc, uint16_t vid,
                                          uint16_t pid) {
  if (!uid || uid[0] == '\0' || loc == 0) return false;

  uint32_t l;
  uint16_t v, p;
  if (obsbot_parse_unique_id(uid, &l, &v, &p)) return l == loc && v == vid && p == pid;
  if (uid[0] == '0' && (uid[1] == 'x' || uid[1] == 'X')) return false; // our form, malformed

  char ids[16], lochex[16];
  snprintf(ids, sizeof ids, "%04x%04x", (unsigned)vid, (unsigned)pid);
  snprintf(lochex, sizeof lochex, "%x", loc);
  return obsbot_contains_nocase(uid, ids) && obsbot_contains_nocase(uid, lochex);
}

#endif
