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

.PHONY: all clean run dist

all: $(HELPER)

$(HELPER): helper.m
	mkdir -p $(TARGET_DIR)
	xcrun clang -fobjc-arc \
		-framework IOKit \
		-framework AVFoundation \
		-framework CoreMedia \
		-framework CoreVideo \
		-framework AppKit \
		-o $@ $^
	chmod +x $@
	@echo "Built: $@"

# Build a fat binary (arm64 + x86_64) for distributable builds (archived
# under native/prebuilt/darwin/ for the CI release pipeline).
dist:
	mkdir -p $(PROJ_ROOT)/native/prebuilt/darwin
	xcrun clang -fobjc-arc -target arm64-apple-macos11 \
		-c helper.m -o /tmp/obsbot-helper-arm64.o
	xcrun clang -fobjc-arc -target x86_64-apple-macos11 \
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
	xcrun clang -fobjc-arc -target x86_64-apple-macos11 \
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

clean:
	rm -f $(HELPER) $(X64_HELPER)
	rm -f $(PROJ_ROOT)/native/prebuilt/darwin/obsbot-helper
