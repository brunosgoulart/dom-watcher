import os
import sys
import traceback

AF_PATH = r"C:\Program Files (x86)\PIPC\AF\PublicAssemblies\4.0\OSIsoft.AFSDK.dll"
print("=== AF SDK PROBE START ===")
print("PYTHON_EXE", sys.executable)
print("AF_PATH", AF_PATH)
print("AF_PATH_EXISTS", os.path.exists(AF_PATH))

try:
    import pythonnet
    print("STEP_1 pythonnet imported")
    pythonnet.load("netfx")
    print("STEP_1_OK pythonnet.load('netfx') succeeded")
except Exception:
    print("STEP_1_FAILED pythonnet.load('netfx')")
    traceback.print_exc()
    sys.exit(2)

try:
    import clr
    print("STEP_2 clr imported")
    try:
        clr.AddReference(AF_PATH)
        print("STEP_2_OK clr.AddReference(path) succeeded")
    except Exception:
        print("STEP_2_FALLBACK clr.AddReference(path) failed; trying Assembly.LoadFrom(path)")
        traceback.print_exc()
        from System.Reflection import Assembly
        asm = Assembly.LoadFrom(AF_PATH)
        print("STEP_2_LOADFROM_OK", asm.FullName)
except Exception:
    print("STEP_2_FAILED AddReference/LoadFrom")
    traceback.print_exc()
    sys.exit(3)

try:
    import OSIsoft.AF.PI
    print("STEP_3_OK import OSIsoft.AF.PI succeeded")
    print("MODULE_REPR", OSIsoft.AF.PI)
except Exception:
    print("STEP_3_FAILED import OSIsoft.AF.PI")
    traceback.print_exc()
    sys.exit(4)

print("=== AF SDK PROBE END ===")
