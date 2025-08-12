const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const Parser = require('rss-parser');
const nodemailer = require('nodemailer');
const lowdb = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const ejs = require('ejs');
const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
const port = process.env.PORT || 3000;

// Determinar o caminho do db.json com base no ambiente
const isRender = process.env.NODE_ENV === 'production';
const dbPath = isRender ? '/db.json' : path.join(__dirname, 'data', 'db.json');

// Verificar se o diretório pai existe (apenas no ambiente local, pois Render gerencia /app/data)
const dbDir = path.dirname(dbPath);
if (!isRender && !fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Diretório criado localmente: ${dbDir}`);
  } catch (err) {
    console.error(`Erro ao criar diretório ${dbDir}:`, err);
  }
}

const adapter = new FileSync(dbPath);
const db = lowdb(adapter);

db.defaults({ subscribers: [], articles: [] }).write();

let newsCache = {};

const transporter = nodemailer.createTransport({
  service: 'Outlook365',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.set('view engine', 'ejs');
app.set('views', 'public');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Inicialização: Verificar variáveis de ambiente
console.log('Iniciando servidor...');
console.log('Variáveis de ambiente carregadas:', {
  EMAIL_USER: !!process.env.EMAIL_USER,
  EMAIL_PASS: !!process.env.EMAIL_PASS,
  TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM: !!process.env.TWILIO_WHATSAPP_FROM,
  PORT: port,
  DB_PATH: dbPath
});

// Busca inicial de notícias no startup com tratamento de erros
(async () => {
  try {
    const subscribers = db.get('subscribers').value() || [];
    const parser = new Parser();
    for (let sub of subscribers) {
      const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(sub.topic)}&hl=pt-BR&gl=BR&ceid=BR:pt`;
      const feed = await parser.parseURL(feedUrl);
      const articles = (feed.items || []).map(item => ({
        title: item.title || 'Sem título',
        description: item.contentSnippet || 'Sem descrição',
        link: item.link,
        pubDate: item.pubDate,
        source: item.source || 'Google News',
        topic: sub.topic
      })).slice(0, 10);
      if (articles.length > 0) {
        newsCache[sub.topic] = articles;
        db.get('articles').push(...articles).write();
      }
    }
    console.log('Busca inicial de notícias concluída. Cache:', newsCache);
  } catch (err) {
    console.error('Erro na busca inicial de notícias:', err);
  }
})();

app.get('/', (req, res) => {
  const subscribers = db.get('subscribers').value() || [];
  const topics = subscribers.map(s => s.topic) || [];
  console.log('Assinantes e tópicos passados para index.ejs:', { subscribers, topics });
  res.render('index', { subscribers, topics });
});

app.post('/subscribe', (req, res) => {
  const { topic, email } = req.body;
  if (!topic || !email) {
    return res.status(400).send('Tópico e e-mail são obrigatórios!');
  }
  const subscriber = { 
    topic: topic.trim().toLowerCase(), 
    email: email.trim(), 
    lastCheck: Date.now(), 
    lastArticles: [] 
  };
  if (!db.get('subscribers').find({ topic: subscriber.topic, email: subscriber.email }).value()) {
    db.get('subscribers').push(subscriber).write();
    (async () => {
      try {
        const parser = new Parser();
        const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(subscriber.topic)}&hl=pt-BR&gl=BR&ceid=BR:pt`;
        const feed = await parser.parseURL(feedUrl);
        const articles = (feed.items || []).map(item => ({
          title: item.title || 'Sem título',
          description: item.contentSnippet || 'Sem descrição',
          link: item.link,
          pubDate: item.pubDate,
          source: item.source || 'Google News',
          topic: subscriber.topic
        })).slice(0, 10);
        if (articles.length > 0) {
          newsCache[subscriber.topic] = articles;
          db.get('articles').push(...articles).write();
        }
      } catch (err) {
        console.error('Erro na busca de notícias para novo assinante:', err);
      }
    })();
  }
  res.redirect('/');
});

app.post('/unsubscribe', (req, res) => {
  const { topic, email } = req.body;
  db.get('subscribers').remove({ topic, email }).write();
  res.redirect('/');
});

app.get('/reset-db', (req, res) => {
  db.set('subscribers', []).write();
  db.set('articles', []).write();
  newsCache = {};
  res.redirect('/');
});

app.get('/subscribe', (req, res) => {
  const { startDate, endDate, topic } = req.query;
  const subscribers = db.get('subscribers').value() || [];
  const subscribedTopics = subscribers.map(s => s.topic) || [];
  let articles = [];
  subscribedTopics.forEach(st => {
    articles = articles.concat(newsCache[st] || []);
  });

  if (topic) {
    articles = articles.filter(a => a.topic.toLowerCase() === topic.toLowerCase());
  }
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    articles = articles.filter(a => {
      const pubDate = new Date(a.pubDate);
      return pubDate >= start && pubDate <= end;
    });
  } else if (startDate) {
    const start = new Date(startDate);
    articles = articles.filter(a => new Date(a.pubDate) >= start);
  } else if (endDate) {
    const end = new Date(endDate);
    articles = articles.filter(a => new Date(a.pubDate) <= end);
  }

  res.render('subscribe', {
    articles,
    topics: subscribedTopics,
    query: req.query || {}
  });
});

app.post('/send-whatsapp', (req, res) => {
  const { selectedArticles, whatsappNumber } = req.body;
  const links = Array.isArray(selectedArticles) ? selectedArticles.join('\n') : selectedArticles;
  twilio.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:+${whatsappNumber.replace(/[^\d]/g, '')}`,
    body: `Notícias selecionadas:\n${links}`
  }).then(() => res.send('Mensagens enviadas via WhatsApp!'))
    .catch(err => res.status(500).send('Erro ao enviar WhatsApp: ' + err.message));
});

async function fetchNews(topic) {
  const parser = new Parser();
  try {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=pt-BR&gl=BR&ceid=BR:pt`;
    const feed = await parser.parseURL(feedUrl);
    return (feed.items || []).map(item => ({
      title: item.title || 'Sem título',
      description: item.contentSnippet || 'Sem descrição',
      link: item.link,
      pubDate: item.pubDate,
      source: item.source || 'Google News',
      topic: topic
    })).slice(0, 10);
  } catch (err) {
    console.error(`Erro ao buscar notícias para ${topic}:`, err);
    return [];
  }
}

function formatEmailContent(topic, articles) {
  const now = new Date();
  const greeting = now.getUTCHours() < 12 ? 'Bom dia' : now.getUTCHours() < 18 ? 'Boa tarde' : 'Boa noite';
  return `
    <h1>${greeting}, ${now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
    <p>Atualização sobre "${topic}":</p>
    <ul>
      ${articles.slice(0, 5).map(a => `
        <li><strong>${a.title}</strong><br>${a.description}<br>Fonte: ${a.source}<br>Data: ${new Date(a.pubDate).toLocaleString('pt-BR')}<br><a href="${a.link}">Leia mais</a></li>
      `).join('')}
    </ul>
    <p>Atualizado por: Sistema Newsletter Pro</p>
  `;
}

async function sendEmail(to, subject, html) {
  const mailOptions = { from: process.env.EMAIL_USER, to, subject, html };
  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err);
    return false;
  }
}

cron.schedule('0 * * * *', async () => {
  try {
    const subscribers = db.get('subscribers').value();
    for (let sub of subscribers) {
      const articles = await fetchNews(sub.topic);
      if (articles.length > 0) {
        newsCache[sub.topic] = articles;
        db.get('articles').push(...articles).write();
        const newArticles = articles.filter(a => !sub.lastArticles.some(la => la.link === a.link));
        if (newArticles.length > 0) {
          const htmlContent = formatEmailContent(sub.topic, newArticles);
          await sendEmail(sub.email, `Atualização - ${sub.topic}`, `<html><body>${htmlContent}</body></html>`);
          sub.lastArticles = [...sub.lastArticles, ...newArticles.map(a => ({ link: a.link, pubDate: a.pubDate }))].slice(-10);
          db.write();
        }
      }
    }
  } catch (err) {
    console.error('Erro no cron job:', err);
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${port}`);
});