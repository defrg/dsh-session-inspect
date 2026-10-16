/**
 * dsh-session-inspect — Client half：在「设置 → 插件 → dsh-session-inspect」页面里渲染配置卡片
 * （DSH 数据根 / 会话日志目录 / 导出目录）。
 *
 * 为什么必须有它：DSH **不会**为第三方 bundle 自动生成配置表单。承载槽位是
 * `plugins.bundle.config`（key = 包名，渲染在 bundle 页面的描述与行之间）。
 * 读写走插件自己的宿主路由 `/session-inspect/api/config`（宿主用官方 `settings.update()`
 * 写进 profile 覆盖层），保存后 volatile 值即时生效、无需重启。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-inspect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useState } = React;
    const h = React.createElement;

    const API = "/session-inspect/api/config";
    const CSS_ID = "dsh-session-inspect-settings";
    const CSS = [
      ".dsi-card{display:flex;flex-direction:column;gap:10px;padding:10px 0 4px}",
      ".dsi-row{display:flex;flex-direction:column;gap:4px}",
      ".dsi-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
      ".dsi-input{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);",
      "border-radius:6px;background:var(--dsw-alias-bg-elevated,transparent);color:inherit;",
      "font-family:inherit;font-size:12px;width:100%;box-sizing:border-box}",
      ".dsi-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit);word-break:break-all}",
      ".dsi-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dsi-btn{height:26px;padding:0 10px;border:0;border-radius:6px;cursor:pointer;font-family:inherit;",
      "font-size:12px;background:var(--dsw-alias-bg-accent,#3b82f6);color:#fff}",
      ".dsi-btn[disabled]{opacity:.5;cursor:default}",
      ".dsi-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,inherit);",
      "border:1px solid var(--dsw-alias-border-secondary,#d0d5dd)}",
      ".dsi-status{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
      ".dsi-status[data-tone=error]{color:#dc2626}",
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
      const style = document.createElement("style");
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const FIELDS = [
      { key: "dshHome", label: "DSH 数据根", placeholder: "留空 = DSH_HOME 环境变量，再退到 ~/.dsh" },
      { key: "sessionsDir", label: "会话日志目录", placeholder: "留空 = <DSH 数据根>/sessions" },
      { key: "exportDir", label: "导出目录", placeholder: "留空 = <DSH 数据根>/session-exports" },
    ];

    const emptyValues = () => ({ dshHome: "", sessionsDir: "", exportDir: "" });

    function SessionInspectSettingsCard() {
      const [values, setValues] = useState(null);
      const [effective, setEffective] = useState(null);
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState("加载中…");
      const [tone, setTone] = useState("info");

      const applyResult = useCallback((result) => {
        const raw = result?.values ?? {};
        setValues({ dshHome: raw.dshHome ?? "", sessionsDir: raw.sessionsDir ?? "", exportDir: raw.exportDir ?? "" });
        setEffective(result?.effective ?? null);
      }, []);

      useEffect(() => {
        ensureCss();
        let alive = true;
        fetch(API, { headers: { accept: "application/json" } })
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return;
            if (body && body.ok) {
              applyResult(body.result);
              setTone("info");
              setStatus("");
            } else {
              setTone("error");
              setStatus((body && body.error) || "读取失败");
            }
          })
          .catch((error) => {
            if (!alive) return;
            setTone("error");
            setStatus("读取失败：" + ((error && error.message) || String(error)));
          });
        return () => {
          alive = false;
        };
      }, [applyResult]);

      const onChange = useCallback(
        (key) => (event) => {
          const next = event.target.value;
          setValues((prev) => ({ ...(prev ?? emptyValues()), [key]: next }));
        },
        [],
      );

      const save = useCallback(() => {
        setBusy(true);
        setTone("info");
        setStatus("保存中…");
        fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values ?? emptyValues()) })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok) {
              applyResult(body.result);
              setTone("info");
              setStatus("已保存" + (body.result && body.result.writtenTo ? "（写入 " + body.result.writtenTo + "）" : "") + "，立即生效");
            } else {
              setTone("error");
              setStatus((body && body.error) || "保存失败");
            }
          })
          .catch((error) => {
            setTone("error");
            setStatus("保存失败：" + ((error && error.message) || String(error)));
          })
          .finally(() => setBusy(false));
      }, [values, applyResult]);

      if (values === null) {
        return h("div", { className: "dsi-card" }, h("div", { className: "dsi-status", "data-tone": tone }, status));
      }

      return h(
        "div",
        { className: "dsi-card" },
        FIELDS.map((field) =>
          h(
            "label",
            { className: "dsi-row", key: field.key },
            h("span", { className: "dsi-label" }, field.label),
            h("input", {
              className: "dsi-input",
              value: values[field.key] ?? "",
              placeholder: field.placeholder,
              spellCheck: false,
              disabled: busy,
              onChange: onChange(field.key),
            }),
          ),
        ),
        h(
          "div",
          { className: "dsi-actions" },
          h("button", { className: "dsi-btn", type: "button", disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
          h(
            "button",
            {
              className: "dsi-btn dsi-btn-ghost",
              type: "button",
              disabled: busy,
              onClick: () => {
                setValues(emptyValues());
                setTone("info");
                setStatus("已清空，点保存后恢复自动探测");
              },
            },
            "清空（改用自动探测）",
          ),
          h("span", { className: "dsi-status", "data-tone": tone }, status),
        ),
        effective
          ? h(
              "div",
              { className: "dsi-hint" },
              "当前生效的数据根：",
              effective.dshHome || "(未探测到)",
              "（",
              effective.dshHomeSource || "来源未知",
              "）",
              h("br"),
              "会话目录：",
              effective.sessionsDir || "(未推导出)",
              h("br"),
              "导出目录：",
              effective.exportDir || "(未推导出)",
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", id: "dsh-session-inspect-bundle-config", key: "dsh-session-inspect" },
          (ownerProps = {}) => (ownerProps && ownerProps.view === "summary" ? null : h(SessionInspectSettingsCard, null)),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.SessionInspectSettingsCard = SessionInspectSettingsCard;
    return module.exports;
  },
});
