const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const MAX_BODY = 8 * 1024 * 1024;

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY) throw new Error("حجم الطلب أكبر من الحد المسموح (8MB).");
  }
  try { return JSON.parse(body || "{}"); }
  catch { throw new Error("بيانات الطلب غير صالحة."); }
}

function buildUserContent({ question, code, language, image }) {
  const text = [
    `لغة البرمجة أو نوع السؤال: ${language || "غير محدد"}`,
    `السؤال أو التعليمات:\n${question || "اقرأ السؤال من الصورة المرفقة إن وجدت."}`,
    `الكود المرفق:\n${code || "لا يوجد"}`
  ].join("\n\n");
  if (!image) return text;
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(image)) {
    throw new Error("صيغة الصورة غير مدعومة. استخدم PNG أو JPG أو WEBP.");
  }
  return [
    { type: "text", text: text + "\n\nاقرأ نص السؤال من الصورة أيضًا، ثم حلله واشرحه." },
    { type: "image_url", image_url: { url: image, detail: "high" } }
  ];
}

async function solvePractice(input) {
  const { question = "", code = "", language = "JavaScript", image = "" } = input;
  if (!String(question).trim() && !String(image).trim()) {
    throw new Error("اكتب السؤال أو ارفع صورة له أولًا.");
  }

  const endpoint = process.env.AI_API_URL;
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;

  if (!endpoint || !apiKey || !model) {
    return {
      mode: "setup-required",
      answer: "المشروع جاهز، لكن الذكاء الاصطناعي لم يُربط بعد.",
      explanation: "أضف AI_API_URL وAI_API_KEY وAI_MODEL في متغيرات بيئة الاستضافة. لا تضع المفتاح في ملفات الواجهة أو تشاركه.",
      setupRequired: true
    };
  }

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content: "أنت مدرس برمجة ومساعد تعلم. ساعد في التدريبات والمراجعة وفهم المفاهيم. إذا كانت الصورة تحتوي سؤالًا، استخرج نصه بدقة واذكر إن كان جزء منها غير واضح. قدم الحل خطوة بخطوة، وفسّر سبب الإجابة، وإذا كان السؤال اختيارًا من متعدد فاشرح الاختيار. إذا كانت المعطيات ناقصة فاطلب توضيحًا بدل التخمين. لا تسجل الدخول إلى أي منصة، ولا ترسل إجابات أو تنفذ اختبارات مُقيّمة نيابة عن الطالب. أجب بالعربية الواضحة، واستخدم كتل كود عند الحاجة."
      },
      { role: "user", content: buildUserContent({ question, code, language, image }) }
    ],
    temperature: 0.2
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`خطأ من مزوّد الذكاء الاصطناعي (${response.status}): ${detail}`);
  }
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("وصل رد غير متوقع من مزوّد الذكاء الاصطناعي.");
  return { mode: "ai", answer: content, explanation: "راجع خطوات الحل وشغّل الكود بنفسك للتأكد من فهمك." };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, aiConfigured: Boolean(process.env.AI_API_URL && process.env.AI_API_KEY && process.env.AI_MODEL) });
  }

  if (req.method === "POST" && url.pathname === "/api/solve") {
    try {
      const input = await readBody(req);
      const result = await solvePractice(input);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 400, { error: err.message || "تعذر تنفيذ الطلب." });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { error: "الطريقة غير مسموحة." });
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(ROOT, "." + pathname);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) {
    return send(res, 403, { error: "ممنوع." });
  }

  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, "الصفحة غير موجودة", "text/plain; charset=utf-8");
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    send(res, 200, content, types[path.extname(file)] || "application/octet-stream");
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Practice assistant listening on ${PORT}`));
