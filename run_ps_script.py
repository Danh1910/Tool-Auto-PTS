#!/usr/bin/env python3
# run_photoshop_jsx.py
# Usage:
#   python run_photoshop_jsx.py [path/to/psd_config.json]


import win32com.client
import os
import sys
import time
import tempfile
import traceback

# ---------- Config ----------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JSX_NAME = "export_psd_configurable.jsx"
JSX_PATH = os.path.join(SCRIPT_DIR, JSX_NAME)

KEEP_TEMP_JSX = False

# ---------- Helpers ----------
def exit_with(msg, code=1):
    print(msg)
    sys.exit(code)

def ensure_file_exists(path, what="file"):
    if not os.path.exists(path):
        exit_with(f"Error: {what} not found: {path}")

def read_text_file(path, encoding='utf-8'):
    with open(path, 'r', encoding=encoding) as f:
        return f.read()

def write_text_file(path, text, encoding='utf-8'):
    with open(path, 'w', encoding=encoding, newline='\n') as f:
        f.write(text)

def make_temp_jsx(original_jsx_content, config_path, result_path, log_path=None):
    cfg_escaped = config_path.replace('\\', '\\\\').replace('"', '\\"')
    res_escaped = result_path.replace('\\', '\\\\').replace('"', '\\"')
    prefix = '// Auto-generated wrapper by run_photoshop_jsx.py\n'
    prefix += 'if (typeof $.arguments === "undefined") $.arguments = [];\n'
    prefix += f'$.arguments[0] = "{cfg_escaped}";\n'
    prefix += f'$.arguments[1] = "{res_escaped}";\n'
    if log_path:
        log_escaped = log_path.replace('\\', '\\\\').replace('"', '\\"')
        prefix += f'$.arguments[2] = "{log_escaped}";\n'
    full = prefix + '\n' + original_jsx_content
    fd, tmp_path = tempfile.mkstemp(prefix="psd_jsx_wrapper_", suffix=".jsx", dir=SCRIPT_DIR, text=True)
    os.close(fd)
    write_text_file(tmp_path, full, encoding='utf-8')
    return tmp_path



# ---------- Main ----------
def main():
    # parse args
    config_arg = None
    result_arg = None
    if len(sys.argv) > 1:
        config_arg = sys.argv[1]
    else:
        # default: psd_config.json in same folder
        config_arg = os.path.join(SCRIPT_DIR, "psd_config.json")

    # result json path (optional arg #2)
    if len(sys.argv) > 2:
        result_arg = sys.argv[2]
    else:
        # mặc định để cùng thư mục script
        result_arg = os.path.join(SCRIPT_DIR, "psd_result.json")


    # NEW: optional log path (argv[3])
    log_arg = None
    if len(sys.argv) > 3:
        log_arg = sys.argv[3]
    else:
        # fallback: lấy theo result_arg
        base, _ = os.path.splitext(result_arg)
        log_arg = base + "_debug.log"

    config_arg = os.path.abspath(config_arg)
    result_arg = os.path.abspath(result_arg)
    log_arg = os.path.abspath(log_arg)

    ensure_file_exists(config_arg, what="Config JSON")
    ensure_file_exists(JSX_PATH, what="JSX script")

    try:
        jsx_content = read_text_file(JSX_PATH, encoding='utf-8')
    except Exception as e:
        exit_with(f"Error reading JSX file: {e}")

    try:
        tmp_jsx_path = make_temp_jsx(jsx_content, config_arg, result_arg)
        print(f"Created temporary wrapper JSX: {tmp_jsx_path}")
        print(f"Report JSON will be written to: {result_arg}")
    except Exception as e:
        exit_with(f"Error creating temporary JSX wrapper: {e}")

    ps = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            ps = win32com.client.Dispatch("Photoshop.Application")
            # Hide the UI
            try:
                ps.Visible = False
            except Exception:
                pass
            break
        except Exception as e:
            print(f"Attempt {attempt} to launch Photoshop failed: {e}")
            if attempt < max_attempts:
                time.sleep(2)
            else:
                print("Full traceback:")
                traceback.print_exc()
                # cleanup temp
                if not KEEP_TEMP_JSX and os.path.exists(tmp_jsx_path):
                    try: os.remove(tmp_jsx_path)
                    except: pass
                exit_with("Failed to start Photoshop via COM. Ensure Photoshop installed and COM accessible.", code=2)

    try:
        print("Executing JSX in Photoshop (hidden)...")
        ps.DoJavaScriptFile(tmp_jsx_path)
        print("JSX executed successfully.")
        # đọc report
        if os.path.exists(result_arg):
            try:
                report_txt = read_text_file(result_arg, encoding='utf-8')
                print("[REPORT] " + report_txt)
            except Exception as re:
                print(f"Warning: cannot read report json: {re}")
        else:
            print("Warning: report JSON not found at", result_arg)

        # NEW: đọc log
        if os.path.exists(log_arg):
            try:
                log_txt = read_text_file(log_arg, encoding='utf-8')
                print("----- DEBUG LOG BEGIN -----")
                print(log_txt)
                print("----- DEBUG LOG END -----")
            except Exception as le:
                print(f"Warning: cannot read debug log: {le}")
        else:
            print("Warning: debug log not found at", log_arg)

        print("Check output folder specified in your config JSON.")
    except Exception as e:
        print("Error executing JSX in Photoshop:")
        traceback.print_exc()
        exit_with(f"Execution error: {e}", code=3)
    finally:
        if not KEEP_TEMP_JSX:
            try:
                if os.path.exists(tmp_jsx_path):
                    os.remove(tmp_jsx_path)
                    print("Temporary wrapper removed.")
            except Exception as e:
                print("Warning: failed to remove temp wrapper:", e)

if __name__ == "__main__":
    main()
