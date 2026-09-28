// Tests for unique_id.h. Compiled and run by test/native/unique-id.test.ts.
// Prints one line per failing case and exits non-zero if there were any.
//
// A macOS uniqueID is "0x" + locationID (hex, no leading zeros) + VID (4 hex) +
// PID (4 hex). The cameras here: Tiny 2 = 3564:fef8, Tail 2 = 3564:fefc.

#include <stdio.h>
#include "unique_id.h"

#define VID 0x3564
#define TINY2 0xFEF8
#define TAIL2 0xFEFC

struct c {
  const char *what;
  const char *uid;
  uint32_t loc;
  uint16_t vid;
  uint16_t pid;
  bool want;
};

int main(void) {
  const struct c cases[] = {
    // -- a device's own uniqueID names it --------------------------------------
    { "a Tiny 2 and its own uniqueID", "0x31200003564fef8", 0x3120000, VID, TINY2, true },
    { "a Tail 2 and its own uniqueID", "0x22120003564fefc", 0x2212000, VID, TAIL2, true },
    { "the Tail 2 where it sat on 2026-09-27", "0x32100003564fefc", 0x3210000, VID, TAIL2, true },
    { "hex in upper case", "0X31200003564FEF8", 0x3120000, VID, TINY2, true },
    { "a location with leading zeros dropped", "0x1000003564fef8", 0x00100000, VID, TINY2, true },

    // -- and nobody else's: across models --------------------------------------
    // The case that matters. The Tiny 2 is held by another process, so its own
    // open fails and the helper tries the next device. "0x1100000…" contains
    // "100000", the Tail 2's location. It must not be taken for the Tail 2.
    { "a Tiny 2's uniqueID, a Tail 2 whose location is a substring of it",
      "0x11000003564fef8", 0x00100000, VID, TAIL2, false },
    { "a Tail 2's uniqueID, a Tiny 2 whose location is a substring of it",
      "0x32100003564fefc", 0x00210000, VID, TINY2, false },
    { "the right location, the wrong model", "0x31200003564fef8", 0x3120000, VID, TAIL2, false },
    { "the right location and model, the wrong vendor", "0x3120000046dfef8", 0x3120000, VID, TINY2, false },

    // -- and nobody else's: same model -----------------------------------------
    { "two Tiny 2s, one location a substring of the other",
      "0x11000003564fef8", 0x00100000, VID, TINY2, false },
    { "two Tiny 2s, one location a prefix of the other",
      "0x31200003564fef8", 0x00000312, VID, TINY2, false },

    // -- a form this code has not met -------------------------------------------
    // It may still be matched, loosely — but only to a device whose own vendor,
    // product AND location all appear in it. Never across models.
    { "an unknown form that holds this device's ids", "usb-3120000-3564fef8", 0x3120000, VID, TINY2, true },
    { "an unknown form that holds another model's ids", "usb-3120000-3564fef8", 0x3120000, VID, TAIL2, false },
    { "an unknown form with the location and no ids", "camera-at-3120000", 0x3120000, VID, TINY2, false },
    { "not hex after the 0x", "0x31200003564fexx", 0x3120000, VID, TINY2, false },

    // -- nothing to match --------------------------------------------------------
    { "an empty uniqueID", "", 0x3120000, VID, TINY2, false },
    { "no uniqueID at all", NULL, 0x3120000, VID, TINY2, false },
    { "a location of zero", "0x03564fef8", 0, VID, TINY2, false },
  };

  int failed = 0;
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    const struct c *t = &cases[i];
    bool got = obsbot_unique_id_names(t->uid, t->loc, t->vid, t->pid);
    if (got != t->want) {
      printf("FAIL: %s — wanted %s, got %s\n", t->what, t->want ? "a match" : "no match",
             got ? "a match" : "no match");
      failed++;
    }
  }
  printf("%d of %zu cases failed\n", failed, sizeof(cases) / sizeof(cases[0]));
  return failed == 0 ? 0 : 1;
}
