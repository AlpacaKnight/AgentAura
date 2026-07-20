Import("env")

# The upstream Arduino-ESP32 LittleFS library includes FS.h but this platform
# package omits FS from LittleFS's dependency graph.  Add the framework FS
# include directory through SCons so it applies while compiling the library.
from os.path import join

framework_dir = env.PioPlatform().get_package_dir("framework-arduinoespressif32")
env.Append(CPPPATH=[join(framework_dir, "libraries", "FS", "src")])
