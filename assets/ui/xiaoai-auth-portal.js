(function () {
  "use strict";

  function parsePortalConfig() {
    var raw = document.getElementById("xiaoai-auth-config");
    var text = raw && raw.textContent ? raw.textContent : "";
    if (!String(text || "").trim() && document.body) {
      text = document.body.getAttribute("data-auth-config") || "";
    }
    if (!String(text || "").trim()) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function markBootError(text) {
    var box = document.getElementById("statusBox");
    if (!box) {
      return;
    }
    box.className = "status status-banner err";
    box.textContent = text;
    box.title = text;
  }

  var config = parsePortalConfig();
  var statusBox = document.getElementById("statusBox");
  var authForm = document.getElementById("authForm");
  var openVerifyBtn = document.getElementById("openVerifyBtn");
  var submitLoginBtn = document.getElementById("submitLoginBtn");
  var ticketFieldShell = document.getElementById("ticketFieldShell");

  if (!statusBox || !authForm || !submitLoginBtn) {
    markBootError("登录页结构不完整，请刷新后重试。");
    return;
  }

  if (!config) {
    markBootError("登录页脚本配置读取失败，已切换到兼容提交模式。");
    return;
  }

  var accountInput = authForm.elements.namedItem("account");
  var serverCountryInput = authForm.elements.namedItem("serverCountry");
  var passwordInput = authForm.elements.namedItem("password");
  var ticketInput = authForm.elements.namedItem("ticket");
  var embeddedMode = Boolean(config.embedded);
  var statusUrl = String(config.statusUrl || "");
  var passwordLoginUrl = String(config.passwordLoginUrl || "");
  var verifyTicketUrl = String(config.verifyTicketUrl || "");
  var openVerifyPageApiUrl = String(config.openVerifyPageApiUrl || "");
  var verification = config.verification || null;
  var verificationKey = "";
  var loginInFlight = false;
  var openVerifyPageInFlight = false;
  var verifyInFlight = false;
  var sessionCompleted = Boolean(config.sessionCompleted);
  var statusTimer = null;

  if (!statusUrl || !passwordLoginUrl || !verifyTicketUrl) {
    markBootError("登录页接口配置不完整，已切换到兼容提交模式。");
    return;
  }

  function verificationMethodLabel(methods) {
    var labels = (Array.isArray(methods) ? methods : [])
      .map(function (item) {
        return item === "phone"
          ? "短信验证码"
          : item === "email"
          ? "邮箱验证码"
          : String(item || "").trim();
      })
      .filter(Boolean);
    return labels[0] || "";
  }

  function currentVerificationKey(value) {
    if (!value) {
      return "";
    }
    var methods = Array.isArray(value.methods) ? value.methods.join(",") : "";
    return String(value.verifyUrl || "") + "|" + methods;
  }

  function looksLikeVerificationFlow(raw) {
    return /(验证码|安全验证|二次验证|验证页面|验证链接|identity_session|identity session|verification|verify|短信验证|邮箱验证)/i.test(raw);
  }

  function looksLikePasswordFailure(raw) {
    return /(账号或密码错误|密码错误|密码不正确|密码有误|invalid password|incorrect password|wrong password)/i.test(raw);
  }

  function looksLikeAccountFailure(raw) {
    return /(账号错误|账号不存在|账号无效|账号不正确|invalid account|unknown account|user not found)/i.test(raw);
  }

  function summarizeStatus(kind, text) {
    var raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) {
      return kind === "ok" ? "登录成功" : "等待登录";
    }
    if (/验证码/.test(raw) && /(错|误|无效|失败|过期)/.test(raw)) {
      return "验证码错误";
    }
    if (looksLikeVerificationFlow(raw)) {
      if (/(identity_session|identity session|会话)/i.test(raw) && /(没有|缺少|失效|过期|重新)/.test(raw)) {
        return "请重新打开验证页面";
      }
      if (/(短信|邮箱|邮件|验证码).{0,8}已发送/.test(raw) || /已发送.{0,8}(短信|邮箱|邮件|验证码)/.test(raw)) {
        var sentMethod = verificationMethodLabel(verification && verification.methods);
        return sentMethod ? sentMethod + "已发送" : "验证码已发送";
      }
      if (/(打开|前往|跳转).{0,8}(验证页面|验证链接)/.test(raw) || /官方.{0,8}(验证页面|验证链接)/.test(raw)) {
        return "请打开验证页面";
      }
      if (verification) {
        var verifyMethod = verificationMethodLabel(verification.methods);
        return verifyMethod ? "请输入" + verifyMethod : "请输入验证码";
      }
    }
    if (looksLikePasswordFailure(raw)) {
      return "密码错误";
    }
    if (looksLikeAccountFailure(raw)) {
      return "账号错误";
    }
    if (/登录成功|账号已登录/.test(raw)) {
      return "登录成功";
    }
    if (/处理中|正在|稍候/.test(raw)) {
      return "正在处理…";
    }
    if (verification) {
      var method = verificationMethodLabel(verification.methods);
      return method ? "请输入" + method : "请输入验证码";
    }
    if (kind === "err") {
      return raw.slice(0, 32);
    }
    return raw.slice(0, 32) || "等待登录";
  }

  function queueEmbeddedLayoutReport() {
    if (!embeddedMode) {
      return;
    }
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(reportEmbeddedLayout);
    });
  }

  function setStatus(kind, text) {
    statusBox.className = "status status-banner" + (kind ? " " + kind : "");
    var raw = String(text || "").trim();
    var concise = summarizeStatus(kind, raw);
    statusBox.textContent = concise;
    statusBox.title = raw || concise;
    queueEmbeddedLayoutReport();
    if (embeddedMode && window.parent && window.parent !== window) {
      try {
        window.parent.postMessage(
          {
            source: "xiaoai-cloud-portal",
            type: "status",
            payload: { kind: kind, text: concise },
          },
          window.location.origin
        );
      } catch (_) {}
    }
  }

  function measureEmbeddedHeight() {
    var doc = document.documentElement;
    var body = document.body;
    return Math.max(
      doc ? doc.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
  }

  function reportEmbeddedLayout() {
    if (!embeddedMode || !window.parent || window.parent === window) {
      return;
    }
    try {
      window.parent.postMessage(
        {
          source: "xiaoai-cloud-portal",
          type: "layout",
          payload: {
            height: measureEmbeddedHeight(),
          },
        },
        window.location.origin
      );
    } catch (_) {}
  }

  function updateFormTarget() {
    authForm.method = "post";
    authForm.action =
      verification && verification.verifyUrl ? verifyTicketUrl : passwordLoginUrl;
  }

  function updateActionButtons() {
    var busy = loginInFlight || openVerifyPageInFlight || verifyInFlight;
    submitLoginBtn.disabled = busy || sessionCompleted;
    submitLoginBtn.textContent = sessionCompleted ? "已完成" : "登录";
    if (openVerifyBtn) {
      var canOpenVerify = Boolean(
        verification && verification.verifyUrl && !sessionCompleted
      );
      openVerifyBtn.hidden = !canOpenVerify;
      openVerifyBtn.disabled = busy || !canOpenVerify;
      openVerifyBtn.textContent = "打开验证页面";
    }
    updateFormTarget();
    queueEmbeddedLayoutReport();
  }

  function renderVerification(nextVerification) {
    verification = nextVerification || null;
    var nextKey = currentVerificationKey(verification);
    if (!verification) {
      verificationKey = "";
      if (ticketInput) {
        ticketInput.value = "";
      }
      if (ticketFieldShell) {
        ticketFieldShell.hidden = true;
      }
    } else if (nextKey !== verificationKey) {
      verificationKey = nextKey;
      if (ticketFieldShell) {
        ticketFieldShell.hidden = false;
      }
    } else if (ticketFieldShell) {
      ticketFieldShell.hidden = false;
    }
    queueEmbeddedLayoutReport();
    updateActionButtons();
  }

  function fetchStatus() {
    return fetch(statusUrl)
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            throw new Error(data.error || "状态查询失败");
          }
          return data;
        });
      })
      .then(function (data) {
        renderVerification(data.verification || null);
        sessionCompleted = data.status === "success";
        if (data.status === "success") {
          setStatus("ok", data.message || "登录成功");
        } else if (data.status === "error") {
          setStatus("err", data.error || "登录失败");
        } else if (data.status === "processing") {
          setStatus("", data.message || "正在处理登录…");
        } else {
          setStatus("", data.message || "等待登录");
        }
        if (embeddedMode && window.parent && window.parent !== window) {
          try {
            window.parent.postMessage(
              {
                source: "xiaoai-cloud-portal",
                type: "session",
                payload: {
                  status: data.status,
                  message: data.message || data.error || "",
                },
              },
              window.location.origin
            );
          } catch (_) {}
        }
        updateActionButtons();
        return data;
      });
  }

  function postJson(url, payload, options) {
    var timeoutMs = Math.max(
      1000,
      Math.round(
        Number(
          options && Number.isFinite(Number(options.timeoutMs))
            ? options.timeoutMs
            : 15000
        ) || 15000
      )
    );
    var hasAbortController = typeof AbortController === "function";
    var controller = hasAbortController ? new AbortController() : null;
    var timer =
      controller && typeof setTimeout === "function"
        ? setTimeout(function () {
            try {
              controller.abort();
            } catch (_) {}
          }, timeoutMs)
        : null;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        return res.text().then(function (rawText) {
          var data = {};
          if (rawText) {
            try {
              data = JSON.parse(rawText);
            } catch (_) {
              throw new Error("服务端返回了非 JSON 响应（HTTP " + res.status + "）。");
            }
          }
          if (!res.ok) {
            throw new Error((data && data.error) || "请求失败（HTTP " + res.status + "）");
          }
          return data;
        });
      })
      .catch(function (error) {
        if (error && typeof error === "object" && error.name === "AbortError") {
          throw new Error("请求超时（>" + timeoutMs + "ms）");
        }
        throw error;
      })
      .finally(function () {
        if (timer) {
          clearTimeout(timer);
        }
      });
  }

  function loginByPassword() {
    if (loginInFlight || openVerifyPageInFlight || verifyInFlight || sessionCompleted) {
      return Promise.resolve();
    }
    var account = String((accountInput && accountInput.value) || "").trim();
    var password = String((passwordInput && passwordInput.value) || "");
    if (!account) {
      setStatus("err", "请先填写小米账号。");
      return Promise.resolve();
    }
    if (!password.trim()) {
      setStatus("err", "请先填写小米账号密码。");
      return Promise.resolve();
    }
    renderVerification(null);
    loginInFlight = true;
    updateActionButtons();
    setStatus("", "正在登录，请稍候…");
    return postJson(passwordLoginUrl, {
      account: account,
      password: password,
      serverCountry: String((serverCountryInput && serverCountryInput.value) || "cn"),
    })
      .then(function () {
        return fetchStatus();
      })
      .catch(function (error) {
        setStatus("err", (error && error.message) || String(error));
      })
      .finally(function () {
        loginInFlight = false;
        updateActionButtons();
      });
  }

  function verifyByTicket(ticketOverride) {
    if (verifyInFlight || loginInFlight || openVerifyPageInFlight || sessionCompleted) {
      return Promise.resolve();
    }
    var ticket =
      typeof ticketOverride === "string"
        ? ticketOverride.trim()
        : String((ticketInput && ticketInput.value) || "").trim();
    var externalContinueAttempt = !ticket && Boolean(verification && verification.verifyUrl);
    if (!ticket && !externalContinueAttempt) {
      setStatus("err", "请先填入短信或邮箱收到的验证码。");
      return Promise.resolve();
    }
    verifyInFlight = true;
    updateActionButtons();
    setStatus(
      "",
      externalContinueAttempt
        ? "正在检查官方验证结果并继续登录，请稍候…"
        : "正在校验验证码并继续登录，请稍候…"
    );
    return postJson(verifyTicketUrl, { ticket: ticket })
      .then(function () {
        return fetchStatus();
      })
      .catch(function (error) {
        setStatus("err", (error && error.message) || String(error));
      })
      .finally(function () {
        verifyInFlight = false;
        updateActionButtons();
      });
  }

  function openVerifyPage() {
    if (
      !verification ||
      !verification.verifyUrl ||
      openVerifyPageInFlight ||
      loginInFlight ||
      verifyInFlight ||
      sessionCompleted
    ) {
      return Promise.resolve();
    }
    var openedWindow = window.open("about:blank", "_blank", "noopener");
    if (!openedWindow) {
      setStatus("err", "浏览器拦截了验证页面，请允许弹窗后重试。");
      return Promise.resolve();
    }
    openVerifyPageInFlight = true;
    updateActionButtons();
    setStatus("", "正在打开官方验证页面，请稍候…");
    var initialVerifyUrl = String((verification && verification.verifyUrl) || "").trim();
    if (/^https?:\/\//i.test(initialVerifyUrl)) {
      try {
        openedWindow.location.href = initialVerifyUrl;
      } catch (_) {}
    }
    return postJson(openVerifyPageApiUrl, {})
      .then(function (data) {
        var openUrl = String(
          (data && (data.openUrl || (data.verification && data.verification.verifyUrl))) || ""
        ).trim();
        if (!openUrl) {
          throw new Error("当前没有可用的官方验证页面。");
        }
        openedWindow.location.href = openUrl;
        setStatus("", "请在官方页面获取验证码，回到这里填写后再点登录。");
      })
      .catch(function (error) {
        var fallbackVerifyUrl = String((verification && verification.verifyUrl) || "").trim();
        if (/^https?:\/\//i.test(fallbackVerifyUrl)) {
          try {
            openedWindow.location.href = fallbackVerifyUrl;
            setStatus(
              "",
              "验证页面接口异常，已回退为直接打开小米验证页。完成后请回到此页填写验证码。"
            );
            return;
          } catch (_) {}
        }
        try {
          openedWindow.close();
        } catch (_) {}
        setStatus("err", (error && error.message) || String(error));
      })
      .finally(function () {
        openVerifyPageInFlight = false;
        updateActionButtons();
      });
  }

  function handlePrimaryAction() {
    if (verification) {
      if (!String((ticketInput && ticketInput.value) || "").trim()) {
        if (verification.verifyUrl) {
          return verifyByTicket("");
        }
        setStatus("err", "请先填入验证码，再点登录。");
        return Promise.resolve();
      }
      return verifyByTicket();
    }
    return loginByPassword();
  }

  authForm.addEventListener("submit", function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    Promise.resolve(handlePrimaryAction()).catch(function (error) {
      setStatus("err", (error && error.message) || String(error));
    });
  }, true);

  if (openVerifyBtn) {
    openVerifyBtn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openVerifyPage();
    }, true);
  }

  renderVerification(verification);
  updateActionButtons();
  queueEmbeddedLayoutReport();
  if (embeddedMode && typeof ResizeObserver === "function") {
    var embeddedResizeObserver = new ResizeObserver(function () {
      queueEmbeddedLayoutReport();
    });
    embeddedResizeObserver.observe(document.body);
  }
  window.addEventListener("resize", queueEmbeddedLayoutReport);
  fetchStatus().catch(function () {});
  statusTimer = setInterval(function () {
    fetchStatus().catch(function () {});
  }, 3000);
  if (statusTimer && typeof statusTimer.unref === "function") {
    statusTimer.unref();
  }
})();
