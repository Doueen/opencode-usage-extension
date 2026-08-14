#!/usr/bin/env python3
# popup UI 视觉验证：headless-shell 加载 popup.html，注入 chrome API mock，渲染「实际用量」区块
import json, pathlib, time, sys
from playwright.sync_api import sync_playwright

DIR = "/root/notes/research/edge-extension"
OUT = "/root/notes/research/edge-extension/screenshots"

POPUP = "file://" + DIR + "/popup.html"
NOW = int(time.time() * 1000)

CHROME_MOCK = """
window.chrome = {
  runtime: {
    sendMessage: (msg, cb) => {
      const quota = { rolling:{resetInSec:3600,usagePercent:12}, weekly:{resetInSec:172800,usagePercent:45},
                      monthly:{resetInSec:1036800,usagePercent:67}, workspaceName:"wrk_mock", plan:"pro", fetchedAt: Date.now() };
      const usage = { quota, updatedAt: Date.now(), lastError: null,
                      balance: { available:true, balances:[{currency:"CNY", total:"88.88", granted:"8.88", topped_up:"80.00"}] } };
      if (msg.type === "get") cb && cb(usage);
      if (msg.type === "refresh") cb && cb(usage);
      if (msg.type === "get_usage_detail") cb && cb(__DETAIL__);
      if (msg.type === "get_badge") cb && cb("rolling");
      if (msg.type === "get_interval") cb && cb(30);
    },
    getURL: p => "chrome-extension://mock/" + p
  },
  storage: { local: {
    get: (keys, cb) => {
      const store = { oc_interval_sec:30, oc_theme:__THEME__, oc_wsid:"wrk_mock",
                      ds_key:null, ds_enabled:true, oc_badge:"rolling", oc_usage:{}, oc_usage_detail:{} };
      let result = {};
      if (typeof keys === "string") result = { [keys]: store[keys] };
      else if (Array.isArray(keys)) keys.forEach(k => result[k] = store[k]);
      else result = store;
      const p = Promise.resolve(result);
      if (cb) p.then(cb);
      return p;
    },
    set: obj => { Object.assign({}, obj); return Promise.resolve(); }
  }},
  tabs: { create: () => {}, query: () => Promise.resolve([]) },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  alarms: { clear: () => Promise.resolve(), create: () => Promise.resolve() }
};
"""

def run(detail_json, theme, shot):
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
        page = browser.new_page(viewport={"width": 400, "height": 900}, device_scale_factor=2)
        mock = CHROME_MOCK.replace("__DETAIL__", detail_json).replace("__THEME__", json.dumps(theme))
        page.add_init_script(mock)
        page.goto(POPUP)
        page.wait_for_timeout(900)
        # 截图 popup 主体（模拟 popup 弹层，去滚动）
        page.screenshot(path=shot, full_page=True)
        browser.close()

detail_ok = json.dumps({"today":{"tokens":33862395,"cost":0.1564,"calls":150},
                        "month":{"tokens":33862395,"cost":0.1564,"calls":150},
                        "monthKey":"2026-08","updatedAt":NOW,"wsId":"wrk_mock","limited":True,
                        "dailyCosts":[{"date":"08-08","cost":1.0742},{"date":"08-09","cost":0.3522},
                                      {"date":"08-10","cost":2.6907},{"date":"08-11","cost":3.8587},
                                      {"date":"08-12","cost":4.9766},{"date":"08-13","cost":5.7320},
                                      {"date":"08-14","cost":1.4213}]})
detail_err = json.dumps({"error":"HTTP 401","wsId":"wrk_mock","updatedAt":NOW})

run(detail_ok, "cyber", OUT + "/usage-detail-cyber.png")
run(detail_ok, "paper", OUT + "/usage-detail-paper.png")
run(detail_err, "matrix", OUT + "/usage-detail-error.png")
print("screenshots done")
