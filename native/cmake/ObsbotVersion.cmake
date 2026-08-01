# Single source of truth for the native helpers' version: package.json.
#
# The helpers are compiled separately from the Node package, so they cannot
# import package.json the way src/ can. Each one therefore carried a hand-edited
# version literal, and test/version-sync.test.ts regexed the sources to catch
# drift — which it did, but only AFTER someone had already edited five other
# sites and missed one. package.json reached 0.4.0 while all three helpers still
# reported 0.1.0; three minor releases of drift, invisible because a compiled
# binary is not something a TS test can read.
#
# CMake gained JSON parsing in 3.19 and all three helpers already require 3.20,
# so the version is simply read at configure time. Defines OBSBOT_VERSION for
# the including CMakeLists to hand to target_compile_definitions().
#
# The version is a RUNTIME fact — the helper reports it over the stdio
# handshake — so a stale value is not a cosmetic problem. Every failure mode
# below is therefore fatal rather than defaulted.

set(_obsbot_pkg "${CMAKE_CURRENT_LIST_DIR}/../../package.json")

if(NOT EXISTS "${_obsbot_pkg}")
  message(FATAL_ERROR
    "ObsbotVersion: cannot find package.json at ${_obsbot_pkg}. "
    "The helpers read their version from it; building without it would ship a "
    "binary that lies about its version.")
endif()

file(READ "${_obsbot_pkg}" _obsbot_pkg_json)
string(JSON OBSBOT_VERSION ERROR_VARIABLE _obsbot_json_err GET "${_obsbot_pkg_json}" version)

if(_obsbot_json_err)
  message(FATAL_ERROR "ObsbotVersion: could not read .version from package.json: ${_obsbot_json_err}")
endif()

if(NOT OBSBOT_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
  message(FATAL_ERROR
    "ObsbotVersion: package.json version '${OBSBOT_VERSION}' is not plain semver. "
    "The publish pipeline assumes MAJOR.MINOR.PATCH.")
endif()

# Without this, bumping the version does not re-run cmake, so the compile
# definition stays stale and the rebuilt helper still reports the old version —
# precisely the silent-staleness failure this file exists to remove.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_obsbot_pkg}")

message(STATUS "obsbot helper version ${OBSBOT_VERSION} (from package.json)")
