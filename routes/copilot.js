
const express = require('express');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_TIMEOUT_MS = 30_000;

async function askGemini(apiKey, prompt) {
  
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
  });
  const data = await response.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error((data && data.error && data.error.message) || `Gemini HTTP ${response.status}`);
  return parts.map(p => p.text || '').join('\n');
}


function extractCommands(text) {
  const commands = [];
  const blocks = String(text).match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g) || [];
  for (const block of blocks) {
    block.replace(/```(?:bash|sh|shell)?\n?|```/g, '').split(/\r?\n/).forEach(line => {
      const cleaned = line.trim();
      if (cleaned && !cleaned.startsWith('#')) commands.push(cleaned);
    });
  }
  return commands;
}

const LOCAL_PLANS = [
  {
    match: ['node', 'نود'],
    title: 'تثبيت Node.js على السيرفر',
    description: 'تنزيل وتثبيت أحدث إصدار من Node.js LTS على السيرفر باستخدام apt، ثم التحقق من نجاح التثبيت.',
    commands: ['curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -', 'sudo apt-get install -y nodejs', 'node -v && npm -v']
  },
  {
    match: ['nginx', 'ويب', 'web server'],
    title: 'تثبيت وضبط خادم الويب Nginx',
    description: 'تثبيت خادم Nginx لخدمة المواقع وتوجيه الحزم العكسي (Reverse Proxy) مع تفعيل جدار الحماية.',
    commands: ['sudo apt update && sudo apt install -y nginx', 'sudo ufw allow "Nginx Full"', 'sudo systemctl enable nginx && sudo systemctl restart nginx', 'systemctl status nginx --no-pager']
  },
  {
    match: ['docker', 'دوكر'],
    title: 'إدارة حاويات Docker',
    description: 'فحص الحاويات النشطة واستعراض استهلاكها للموارد.',
    commands: ['docker ps -a --format "table {{.ID}}\\t{{.Image}}\\t{{.Status}}\\t{{.Names}}"', 'docker stats --no-stream']
  },
  {
    match: ['pm2', 'بوت', 'bot', 'restart'],
    title: 'إعادة تشغيل خدمات PM2 ومراقبة الحالة',
    description: 'إعادة تحميل كافة العمليات النشطة وعرض تقرير الحالة المباشر.',
    commands: ['pm2 reload all', 'pm2 status', 'pm2 logs --lines 15 --nostream']
  },
  {
    match: ['disk', 'قرص', 'مساحة', 'storage'],
    title: 'تحليل استهلاك مساحة القرص',
    description: 'عرض المساحة المتاحة وأكبر المجلدات حجماً لمعرفة ما يستهلك القرص.',
    commands: ['df -h /', 'du -xh / --max-depth=1 2>/dev/null | sort -rh | head -n 10']
  },
  {
    match: ['security', 'امان', 'أمان', 'firewall', 'جدار'],
    title: 'فحص أمان سريع للسيرفر',
    description: 'عرض حالة جدار الحماية والمنافذ المفتوحة وآخر محاولات الدخول الفاشلة.',
    commands: ['sudo ufw status verbose', 'ss -tulpn | head -n 25', 'sudo lastb -n 10 2>/dev/null || true']
  }
];

module.exports = function copilotRouter({ store, ssh, security }) {
  const router = express.Router();
  const { config } = store;
  const apiKey = () => config.geminiApiKey || process.env.GEMINI_API_KEY || '';

  router.get('/copilot/config', (req, res) => {
    const key = apiKey();
    res.json({ success: true, hasKey: Boolean(key), maskedKey: key ? security.maskSecret(key) : '', model: GEMINI_MODEL });
  });

  router.post('/copilot/config', (req, res) => {
    const { apiKey: submitted } = req.body || {};
    if (submitted !== undefined) {
      const trimmed = String(submitted || '').trim();
      if (trimmed && !/^[A-Za-z0-9_-]{20,120}$/.test(trimmed)) {
        return res.status(400).json({ success: false, error: 'Invalid API key format' });
      }
      config.geminiApiKey = trimmed;
      store.save();
    }
    res.json({ success: true, message: 'Gemini API Key saved' });
  });

  router.post('/copilot/chat', async (req, res) => {
    const { message } = req.body || {};
    if (message !== undefined && typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'message must be a string' });
    }
    const userText = String(message || '').trim().slice(0, 4000);
    if (!userText) return res.status(400).json({ success: false, error: 'message is required' });
    const srv = store.getActiveServer();

    const key = apiKey();
    if (key) {
      try {
        let telemetry = `Server: ${srv.name}, OS: Linux.`;
        if (srv.isReal) {
          try {
            const [m, pm2] = await Promise.all([ssh.getLiveMetrics(srv), ssh.getPm2List(srv)]);
            telemetry += `\nLive Stats: CPU ${m.cpuPercent}%, RAM ${m.memoryUsed}GB/${m.memoryTotal}GB (${m.memoryPercent}%), Disk ${m.storagePercent}%, Uptime ${m.uptime}. PM2: ${pm2.map(p => `${p.name} (${p.status}, ${p.memory})`).join(', ') || 'none'}`;
          } catch (_) {  }
        }

        const prompt = `أنت Panel AI، مساعد DevOps ومهندس خوادم Linux ذكي باللغة العربية.
أنت تساعد مدير الخادم في إدارة الخادم وحل مشاكله وتثبيت التطبيقات وتحليل سجلات الأخطاء.
سياق الخادم الحالي:
${telemetry}

إرشادات هامة:
1. أجب بأسلوب تقني مهني ومباشر باللغة العربية.
2. إذا كان الطلب يتطلب تنفيذ أوامر على السيرفر، اكتب الأوامر داخل كود بلوك بصيغة:
\`\`\`bash
الأوامر هنا
\`\`\`
3. اشرح باختصار ماذا سيفعل كل أمر.
4. لا تقترح أبداً أوامر مدمرة (rm -rf /، mkfs، dd على الأقراص) دون تحذير صريح.

سؤال المستخدم: ${userText}`;

        const aiText = await askGemini(key, prompt);
        const commands = extractCommands(aiText);
        if (commands.length > 0) {
          return res.json({
            success: true,
            replyType: 'verified_plan',
            title: `خطة ذكية: ${userText.slice(0, 35)}${userText.length > 35 ? '…' : ''}`,
            verifiedPlan: true,
            description: aiText.replace(/```[\s\S]*?```/g, '').trim().slice(0, 280),
            rawText: aiText,
            commands: commands.slice(0, 8)
          });
        }
        return res.json({ success: true, replyType: 'text', message: aiText });
      } catch (err) {
        console.warn('Gemini API call failed, falling back to local brain:', err.message);
      }
    }

    const text = userText.toLowerCase();
    const plan = LOCAL_PLANS.find(p => p.match.some(word => text.includes(word)));
    if (plan) {
      return res.json({ success: true, replyType: 'verified_plan', verifiedPlan: true, title: plan.title, description: plan.description, commands: plan.commands });
    }

    if (['اهلا', 'أهلا', 'مرحبا', 'hello', 'hi'].some(w => text.includes(w))) {
      return res.json({
        success: true,
        replyType: 'text',
        message: 'أهلاً بك!  أنا Panel AI. اسألني عن أي شيء يخص خادمك (تثبيت برامج، فحص استهلاك، تصحيح أخطاء)، أو أضف مفتاح Gemini API من الإعدادات للذكاء الكامل.'
      });
    }

    return res.json({
      success: true,
      replyType: 'verified_plan',
      verifiedPlan: true,
      title: 'فحص عام لحالة السيرفر',
      description: `لم أتعرف على طلبك "${userText.slice(0, 80)}" في الوضع المحلي. هذه أوامر فحص عامة آمنة؛ أضف مفتاح Gemini للحصول على إجابة مخصصة.`,
      commands: ['uname -a && uptime', 'free -h && df -h /', 'pm2 status']
    });
  });

  router.post('/copilot/analyze-error', async (req, res) => {
    const { serviceName } = req.body || {};
    const srv = store.getActiveServer();

    
    let name = '';
    try {
      name = security.assertSafeName(serviceName, 'process name');
    } catch (err) {
      return security.sendError(res, err, 'analyze-error', 400);
    }
    const quoted = security.shellQuote(name);

    let errorLogs;
    if (srv.isReal) {
      try {
        const out = await ssh.execCommand(srv, security.pm2LogsCommand(name, 40));
        errorLogs = security.redactOutput(out.stdout);
      } catch (err) {
        console.warn('Could not read PM2 logs:', err.message);
        errorLogs = 'Could not read logs for this process.';
      }
    } else {
      errorLogs = `[demo] Error: Cannot find module 'express'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1077)\n[demo] Process exited with code 1`;
    }

    const key = apiKey();
    if (key) {
      try {
        const analysis = await askGemini(key, `حلل سجل أخطاء خدمة PM2 (${name}) التالي في سيرفر Linux:
\`\`\`
${errorLogs.slice(-12000)}
\`\`\`
اشرح سبب العطل باختصار باللغة العربية وقدم أوامر تصحيح دقيقة لإعادة تشغيل الخدمة بنجاح داخل كود بلوك bash.`);
        const commands = extractCommands(analysis);
        return res.json({ success: true, analysis, commands: commands.length ? commands : [`pm2 restart ${quoted}`], errorLogs });
      } catch (err) {
        console.warn('Gemini analysis failed:', err.message);
      }
    }

    res.json({
      success: true,
      analysis: `تحليل أخطاء ${name} (وضع محلي): راجع السجل أعلاه. الأوامر التالية تعرض إعدادات العملية ومجلدها، ثم تعيد تشغيلها. أضف مفتاح Gemini لتحليل أدق.`,
      commands: [`pm2 describe ${quoted}`, `pm2 restart ${quoted}`, `pm2 logs ${quoted} --lines 20 --nostream`],
      errorLogs
    });
  });

  return router;
};

module.exports.extractCommands = extractCommands;
