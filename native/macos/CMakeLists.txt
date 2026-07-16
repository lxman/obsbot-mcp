cmake_minimum_required(VERSION 3.20)
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
