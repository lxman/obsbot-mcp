# Build the macOS obsbot-helper native binary.
#
# Invoke from the project root:
#   make -C native/macos
# Or:
#   cd native/macos && make
#
# Uses xcrun clang with ARC and the needed frameworks.
# Output goes to native/prebuilt/<triple>/obsbot-helper (relative to
# the project root, so HelperProcess.resolveBinaryPath() finds it).

PROJ_ROOT := ../..
TARGET_DIR := $(PROJ_ROOT)/native/prebuilt/darwin-arm64
HELPER    := $(TARGET_DIR)/obsbot-helper

# Minimum macOS version. Without this the binary inherits the build machine's OS
# as its floor and refuses to launch on anything older — a build on macOS 26
# emits minos 26.0. Keep in sync with CMakeLists.txt, which CI uses; a local
# build that differs from the shipped one is how that bug stayed hidden.
# 14.0 is the newest API the helper uses (AVCaptureDeviceTypeExternal).
MIN_MACOS := 14.0

.PHONY: all clean run dist

all: $(HELPER)

$(HELPER): helper.m
	mkdir -p $(TARGET_DIR)
	xcrun clang -fobjc-arc \
		-mmacosx-version-min=$(MIN_MACOS) \
		-framework IOKit \
		-framework AVFoundation \
		-framework CoreMedia \
		-framework CoreVideo \
		-framework AppKit \
		-o $@ $^
	chmod +x $@
	@echo "Built: $@ (minos $(MIN_MACOS))"

# Build a fat binary (arm64 + x86_64) for distributable builds (archived
# under native/prebuilt/darwin/ for the CI release pipeline).
dist:
	mkdir -p $(PROJ_ROOT)/native/prebuilt/darwin
	xcrun clang -fobjc-arc -target arm64-apple-macos$(MIN_MACOS) \
		-c helper.m -o /tmp/obsbot-helper-arm64.o
	xcrun clang -fobjc-arc -target x86_64-apple-macos$(MIN_MACOS) \
		-c helper.m -o /tmp/obsbot-helper-x86_64.o
	xcrun clang -arch arm64 -arch x86_64 \
		-framework IOKit \
		-framework AVFoundation \
		-framework CoreMedia \
		-framework CoreVideo \
		-framework AppKit \
		-o $(PROJ_ROOT)/native/prebuilt/darwin/obsbot-helper \
		/tmp/obsbot-helper-arm64.o /tmp/obsbot-helper-x86_64.o
	rm -f /tmp/obsbot-helper-arm64.o /tmp/obsbot-helper-x86_64.o
	chmod +x $(PROJ_ROOT)/native/prebuilt/darwin/obsbot-helper
	@echo "Built fat binary: $(PROJ_ROOT)/native/prebuilt/darwin/obsbot-helper"
	lipo -info $(PROJ_ROOT)/native/prebuilt/darwin/obsbot-helper

# Quick smoke test: start the helper, send version, expect {"ok":true,...}
run: $(HELPER)
	@echo '{"op":"version"}' | $(HELPER)

# x86_64 version (for Intel Macs or Rosetta)
X64_DIR := $(PROJ_ROOT)/native/prebuilt/darwin-x64
X64_HELPER := $(X64_DIR)/obsbot-helper

$(X64_HELPER): helper.m
	mkdir -p $(X64_DIR)
	xcrun clang -fobjc-arc -target x86_64-apple-macos$(MIN_MACOS) \
		-framework IOKit \
		-framework AVFoundation \
		-framework CoreMedia \
		-framework CoreVideo \
		-framework AppKit \
		-o $@ $^
	chmod +x $@
	@echo "Built: $@"

run64: $(X64_HELPER)
	@echo '{"op":"version"}' | $<

# A helper built by hand in this directory (`clang -o obsbot-helper helper.m`,
# without the -o path the targets above use) shadows nothing the Node stack
# loads, but sits next to the source under an inviting name and goes stale
# silently — running it directly tests whatever code it was built from. Sweep it.
STRAY := obsbot-helper

clean:
	rm -f $(HELPER) $(X64_HELPER)
	rm -f $(PROJ_ROOT)/native/prebuilt/darwin/obsbot-helper
	rm -f $(STRAY)
