cmake_minimum_required(VERSION 3.20)

# Pin the minimum macOS version. Without this the binary inherits the *build
# machine's* OS as its floor — a runner on macOS 26 emits minos 26.0, which the
# loader then refuses to launch on anything older. Must be set before project().
#
# 14.0 is the newest API the helper actually uses (AVCaptureDeviceTypeExternal
# in avfEnumerateCameras; kIOMainPortDefault only needs 12.0). Raising the floor
# below 14 requires an @available guard around the discovery-session types.
set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0" CACHE STRING "Minimum macOS version")

project(obsbot_helper OBJC)
set(CMAKE_OBJC_STANDARD 11)
add_executable(obsbot-helper helper.m)
# ARC, matching the Makefile used for local builds.
target_compile_options(obsbot-helper PRIVATE -fobjc-arc)
target_link_libraries(obsbot-helper PRIVATE
  "-framework IOKit"
  "-framework AVFoundation"
  "-framework CoreMedia"
  "-framework CoreVideo"
  "-framework AppKit")
set_target_properties(obsbot-helper PROPERTIES OUTPUT_NAME "obsbot-helper")
