/**
 * Прокси к Groq: транскрипция (OpenAI-совместимый /v1/audio/transcriptions)
 * и постобработка текста (/v1/chat/completions).
 * Ключ: переменная окружения GROQ_API_KEY или заголовок Authorization: Bearer …
 */
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var authHeader =
    typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  var headerKey =
    authHeader.length > 7 && authHeader.slice(0, 7).toLowerCase() === "bearer "
      ? authHeader.slice(7).trim()
      : "";
  var apiKey = process.env.GROQ_API_KEY || headerKey;

  if (!apiKey) {
    return res.status(401).json({
      error:
        "Нет ключа Groq: задайте GROQ_API_KEY в окружении (например Vercel) или поле ключа в настройках."
    });
  }

  var body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: "Некорректный JSON" });
    }
  }

  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Пустое тело запроса" });
  }

  var action =
    typeof body.action === "string"
      ? body.action.trim()
      : body.action != null
        ? String(body.action).trim()
        : "";

  try {
    if (action === "transcribe") {
      var result = await transcribeGroq(apiKey, body);
      return res.status(200).json(result);
    }
    if (action === "chat") {
      var chatOut = await chatGroq(apiKey, body);
      return res.status(200).json(chatOut);
    }
    return res.status(400).json({
      error: "Нужно поле action: \"transcribe\" или \"chat\"",
      hint: "Проверьте JSON тела запроса (поле action отсутствует или неверное)."
    });
  } catch (err) {
    var msg = err && err.message ? String(err.message) : "Ошибка Groq";
    if (err && err.cause && err.cause.message) {
      msg += " (" + String(err.cause.message) + ")";
    }
    if (process.env.GROQ_DEBUG) {
      console.error("[api/groq]", err);
    }
    var status =
      err && typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 502;
    return res.status(status).json({ error: msg });
  }
};

function appendAudioToForm(form, buffer, filename, mimeType) {
  var type = mimeType || "application/octet-stream";
  /* Только Blob + имя файла: в Node File() иногда даёт multipart, который Groq отклоняет (400). */
  form.append("file", new Blob([buffer], { type: type }), filename);
}

function badRequest(msg) {
  var e = new Error(msg);
  e.statusCode = 400;
  return e;
}

/* Пороги по метаданным сегментов (verbose_json), см. Groq STT docs: no_speech_prob, compression_ratio */
var SEG_NO_SPEECH_MAX = 0.45;
var SEG_COMPRESSION_RATIO_MAX = 2.85;

/**
 * Собирает текст только из сегментов, похожих на речь; отсекает тишину/галлюцинации Whisper.
 * @returns {{ used: boolean, text: string, kept: number, dropped: number, total: number }}
 */
function textFromVerboseSegments(data) {
  if (!data || !Array.isArray(data.segments) || data.segments.length === 0) {
    return { used: false, text: "", kept: 0, dropped: 0, total: 0 };
  }
  var parts = [];
  var dropped = 0;
  var i;
  var seg;
  var segText;
  var nosp;
  var cr;
  for (i = 0; i < data.segments.length; i++) {
    seg = data.segments[i];
    segText = seg && seg.text != null ? String(seg.text).trim() : "";
    if (!segText) continue;
    nosp = typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : 0;
    cr = typeof seg.compression_ratio === "number" ? seg.compression_ratio : 1;
    if (nosp > SEG_NO_SPEECH_MAX) {
      dropped++;
      continue;
    }
    if (cr > SEG_COMPRESSION_RATIO_MAX) {
      dropped++;
      continue;
    }
    parts.push(segText);
  }
  var merged = parts.join(" ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  return {
    used: true,
    text: merged,
    kept: parts.length,
    dropped: dropped,
    total: data.segments.length
  };
}

async function transcribeGroq(apiKey, body) {
  var b64 = typeof body.audioBase64 === "string" ? body.audioBase64.trim() : "";
  if (!b64) {
    throw badRequest("Нет audioBase64 в теле запроса");
  }

  var buffer = Buffer.from(b64, "base64");
  if (!buffer.length) {
    throw badRequest("Пустой аудиобуфер после base64");
  }

  var filename =
    typeof body.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "audio.webm";
  var mimeType =
    typeof body.mimeType === "string" && body.mimeType.trim()
      ? body.mimeType.trim()
      : "audio/webm";
  var model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "whisper-large-v3-turbo";
  /* ISO-639-1. "auto"/"detect"/пропуск → ru (Groq при отсутствии language может отвечать 400). Англ. термины — через prompt на клиенте. */
  var langInput =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim().toLowerCase()
      : "ru";
  var transcribeLang =
    langInput === "auto" || langInput === "detect" ? "ru" : langInput;

  function buildTranscribeForm(verboseJson) {
    var form = new FormData();
    appendAudioToForm(form, buffer, filename, mimeType);
    form.append("model", model);
    form.append("language", transcribeLang);
    form.append("response_format", verboseJson ? "verbose_json" : "json");
    if (verboseJson) {
      form.append("timestamp_granularities[]", "segment");
    }
    form.append("temperature", "0");
    if (typeof body.prompt === "string" && body.prompt.trim()) {
      form.append("prompt", body.prompt.trim().slice(0, 2000));
    }
    return form;
  }

  function parseGroqJson(raw) {
    var data = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        data = {};
        if (process.env.GROQ_DEBUG) {
          console.warn(
            "[api/groq transcribe] JSON.parse не удался:",
            e && e.message,
            "начало ответа:",
            raw.slice(0, 400)
          );
        }
      }
    }
    return data;
  }

  var r;
  var raw;
  var data;
  var usedVerbose = true;

  try {
    r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey
      },
      body: buildTranscribeForm(true)
    });
  } catch (err) {
    throw new Error("Сеть: " + (err && err.message ? err.message : String(err)));
  }

  raw = await r.text();
  data = parseGroqJson(raw);

  if (!r.ok && r.status === 400) {
    if (process.env.GROQ_DEBUG) {
      console.warn(
        "[api/groq transcribe] Groq 400 на verbose_json, повтор без сегментов. Ответ:",
        raw.slice(0, 500)
      );
    }
    usedVerbose = false;
    try {
      r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey
        },
        body: buildTranscribeForm(false)
      });
    } catch (err2) {
      throw new Error("Сеть: " + (err2 && err2.message ? err2.message : String(err2)));
    }
    raw = await r.text();
    data = parseGroqJson(raw);
  }

  if (!r.ok) {
    var apiErr =
      data.error && typeof data.error.message === "string"
        ? data.error.message
        : raw && raw.length
          ? raw.length > 500
            ? raw.slice(0, 500) + "…"
            : raw
          : r.statusText || String(r.status);
    if (process.env.GROQ_DEBUG) {
      console.error("[api/groq transcribe]", r.status, raw && raw.slice ? raw.slice(0, 800) : raw);
    }
    var te = new Error(apiErr);
    te.statusCode = r.status;
    throw te;
  }

  var segMerge = usedVerbose ? textFromVerboseSegments(data) : { used: false, text: "" };
  var outText = "";
  if (segMerge.used) {
    outText = segMerge.text;
  } else if (data && data.text != null) {
    outText = typeof data.text === "string" ? data.text : String(data.text);
  }

  var keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
  if (process.env.GROQ_DEBUG) {
    console.log(
      "[api/groq transcribe]",
      "http=" + r.status,
      "verbose=" + usedVerbose,
      "fileBytes=" + buffer.length,
      "model=" + model,
      "lang=" + transcribeLang,
      "respBytes=" + raw.length,
      "textLen=" + outText.length,
      "jsonKeys=" + JSON.stringify(keys),
      segMerge.used
        ? "segments=" + segMerge.total + " kept=" + segMerge.kept + " dropped=" + segMerge.dropped
        : "segments=—"
    );
    if (!outText.length) {
      console.warn("[api/groq transcribe] пустой text; сырой ответ Groq (до 800 симв.):", raw.slice(0, 800));
    }
    console.log("[api/groq transcribe] GROQ_DEBUG полный raw:", raw);
  }

  return { text: outText };
}

async function chatGroq(apiKey, body) {
  var messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    throw badRequest("Нет messages для chat");
  }

  var model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "llama-3.1-8b-instant";
  var temperature =
    typeof body.temperature === "number" && isFinite(body.temperature) ? body.temperature : 0.2;

  var r;
  try {
    r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: 2048
      })
    });
  } catch (err) {
    throw new Error("Сеть: " + (err && err.message ? err.message : String(err)));
  }

  var raw = await r.text();
  var data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = {};
    }
  }

  if (!r.ok) {
    var chatErr =
      data.error && typeof data.error.message === "string"
        ? data.error.message
        : raw && raw.length
          ? raw.length > 500
            ? raw.slice(0, 500) + "…"
            : raw
          : r.statusText || String(r.status);
    var ce = new Error(chatErr);
    ce.statusCode = r.status;
    throw ce;
  }

  var content =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    typeof data.choices[0].message.content === "string"
      ? data.choices[0].message.content
      : "";

  if (process.env.GROQ_DEBUG) {
    console.log(
      "[api/groq chat]",
      "http=" + r.status,
      "model=" + model,
      "respBytes=" + raw.length,
      "textLen=" + (content ? content.length : 0)
    );
    if (!content.length) {
      console.warn("[api/groq chat] пустой content; jsonKeys=", JSON.stringify(Object.keys(data || {})));
    }
    console.log("[api/groq chat] GROQ_DEBUG raw:", raw.slice(0, 2000));
  }

  return { text: content };
}
