
const express = require('express');

const MASKED_PLACEHOLDER_RE = /•{3,}/;
const DISCORD_WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;
const TELEGRAM_TOKEN_RE = /^\d{6,15}:[A-Za-z0-9_-]{30,60}$/;

module.exports = function alertsRouter({ store, security, monitor }) {
  const router = express.Router();
  const { config } = store;

  function publicAlertsConfig() {
    const a = config.alerts || {};
    return {
      enabled: Boolean(a.enabled),
      pm2Alerts: Boolean(a.pm2Alerts),
      cpuThreshold: a.cpuThreshold,
      ramThreshold: a.ramThreshold,
      diskThreshold: a.diskThreshold,
      telegramChatId: a.telegramChatId || '',
      discordWebhookUrl: a.discordWebhookUrl ? security.maskSecret(a.discordWebhookUrl) : '',
      telegramBotToken: a.telegramBotToken ? security.maskSecret(a.telegramBotToken) : '',
      hasDiscordWebhook: Boolean(a.discordWebhookUrl),
      hasTelegramBotToken: Boolean(a.telegramBotToken)
    };
  }

  router.get('/alerts/config', (req, res) => {
    res.json({ success: true, alerts: publicAlertsConfig() });
  });

  router.post('/alerts/config', (req, res) => {
    const body = req.body || {};
    const next = { ...config.alerts };

    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
    if (body.pm2Alerts !== undefined) next.pm2Alerts = Boolean(body.pm2Alerts);

    for (const key of ['cpuThreshold', 'ramThreshold', 'diskThreshold']) {
      if (body[key] === undefined || body[key] === '') continue;
      const value = parseInt(body[key], 10);
      if (Number.isNaN(value) || value < 1 || value > 100) {
        return res.status(400).json({ success: false, error: `${key} must be between 1 and 100` });
      }
      next[key] = value;
    }

    if (body.telegramChatId !== undefined) {
      const chatId = String(body.telegramChatId || '').trim();
      if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
        return res.status(400).json({ success: false, error: 'Invalid Telegram chat id' });
      }
      next.telegramChatId = chatId;
    }

    
    if (body.discordWebhookUrl !== undefined && !MASKED_PLACEHOLDER_RE.test(String(body.discordWebhookUrl))) {
      const url = String(body.discordWebhookUrl || '').trim();
      if (url && !DISCORD_WEBHOOK_RE.test(url)) {
        return res.status(400).json({ success: false, error: 'Invalid Discord webhook URL' });
      }
      next.discordWebhookUrl = url;
    }

    if (body.telegramBotToken !== undefined && !MASKED_PLACEHOLDER_RE.test(String(body.telegramBotToken))) {
      const token = String(body.telegramBotToken || '').trim();
      if (token && !TELEGRAM_TOKEN_RE.test(token)) {
        return res.status(400).json({ success: false, error: 'Invalid Telegram bot token' });
      }
      next.telegramBotToken = token;
    }

    config.alerts = next;
    store.save();
    res.json({ success: true, message: 'Alerts settings updated', alerts: publicAlertsConfig() });
  });

  router.post('/alerts/test', async (req, res) => {
    const srv = store.getActiveServer();
    const title = ' فحص إشعارات لوحة التحكم Panel';
    const message = `تم إرسال هذا الإشعار التجريبي بنجاح من الخادم: ${srv.name} (${srv.ipMasked}). نظام المراقبة التلقائي يعمل.`;
    const results = await monitor.sendAlert(title, message);
    res.json({ success: true, results });
  });

  return router;
};
