"""Drive headless Chrome over CDP: open a URL, wait wall-clock, then evaluate JS and
collect console messages (page and worker).

Usage: python scripts/cdp_probe.py <url> <wait_seconds> <js-expression> [profile_dir] [pre-expression]

The pre-expression runs halfway through the wait - a click or a form fill - and the
main expression is evaluated at the end. Needs `pip install websocket-client`. Do not
use --virtual-time-budget harnesses for this site: virtual time starves the worker's
synchronous XHR and manufactures hangs."""

import json
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333


def main():
    # Page text is UTF-8; a Windows console defaults to a code page that cannot print it.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    url, wait, expr = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
        "--remote-debugging-port=" + str(PORT), "--remote-allow-origins=*",
        "--user-data-dir=" + sys.argv[4] if len(sys.argv) > 4 else "--user-data-dir=C:\\Users\\spudd\\AppData\\Local\\Temp\\cdp-profile",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        # wait for the endpoint
        for _ in range(50):
            try:
                targets = json.load(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json" % PORT, timeout=1))
                break
            except Exception:
                time.sleep(0.2)
        page = next(t for t in targets if t["type"] == "page")
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
        mid = [0]

        def send(method, params=None):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
            return mid[0]

        logs = []

        def pump(until_id=None, timeout=30):
            end = time.time() + timeout
            while time.time() < end:
                ws.settimeout(max(0.1, end - time.time()))
                try:
                    msg = json.loads(ws.recv())
                except Exception:
                    return None
                if msg.get("method") == "Runtime.consoleAPICalled":
                    args = [a.get("value", a.get("description", "?"))
                            for a in msg["params"]["args"]]
                    logs.append("[console.%s] %s" % (msg["params"]["type"], " ".join(map(str, args))))
                elif msg.get("method") == "Runtime.exceptionThrown":
                    d = msg["params"]["exceptionDetails"]
                    logs.append("[exception] " + json.dumps(d.get("exception", {}).get("description", d))[:400])
                elif msg.get("method") == "Log.entryAdded":
                    e = msg["params"]["entry"]
                    logs.append("[%s/%s] %s" % (e["source"], e["level"], e["text"]))
                if until_id and msg.get("id") == until_id:
                    return msg
            return None

        send("Runtime.enable")
        send("Log.enable")
        # auto-attach to workers so worker console messages arrive on this session
        send("Target.setAutoAttach",
             {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True})
        nav = send("Page.navigate", {"url": url})
        send("Page.enable")
        pump(until_id=nav, timeout=10)
        pre = sys.argv[5] if len(sys.argv) > 5 else None
        if pre:
            time.sleep(wait / 2)
            pump(timeout=0.5)
            send("Runtime.evaluate", {"expression": pre})
        deadline = time.time() + (wait / 2 if pre else wait)
        while time.time() < deadline:
            pump(timeout=min(1.0, deadline - time.time()))
        ev = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = pump(until_id=ev, timeout=15)
        print("=== console/log ===")
        for l in logs[-60:]:
            print(l)
        print("=== evaluate ===")
        if res:
            r = res.get("result", {}).get("result", {})
            v = r.get("value", r.get("description"))
            print(json.dumps(v, indent=1)[:4000] if not isinstance(v, str) else v[:4000])
        else:
            print("no evaluate result")
        ws.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
