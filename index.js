// ===================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL
// ===================================================================================
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const Parser = require('rss-parser');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend"); // Usando a biblioteca correta
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const ejs = require('ejs');
const axios = require('axios');

const app = express();
const port = 3000;

// ===================================================================================
// 2. BANCO DE DADOS (LOWDB) E CACHE
// ===================================================================================
const dbPath = path.join(__dirname, 'db.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);

db.defaults({ subscribers: [], articles: [] }).write();
let newsCache = {};

// ===================================================================================
// 3. FONTES DE NOTÍCIAS (FEEDS RSS)
// ===================================================================================
const topicFeeds = {
    'notícias gerais': [ 'https://news.google.com/rss/search?q=noticias+brasil&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://conectapiaui.com.br/rss.xml', 'https://sonialacerda.com.br/feed/' ],
    'política brasil': [ 'https://news.google.com/rss/search?q=política+brasil&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://www.diariodopoder.com.br/feed/', 'https://www.poder360.com.br/feed/', 'https://www.cartacapital.com.br/feed/' ],
    'ciro nogueira': [ 'https://news.google.com/rss/search?q=Ciro+Nogueira&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://conectapiaui.com.br/rss.xml', 'https://www.diariodopoder.com.br/feed/' ]
};

const sourceMap = {
    'conectapiaui.com.br': 'Conecta Piauí', 'sonialacerda.com.br': 'Blog Sony Lacerda', 'folha.uol.com.br': 'Folha de S.Paulo', 'globo.com': 'Globo', 'g1.globo.com': 'G1', 'poder360.com.br': 'Poder360', 'uol.com.br': 'UOL', 'estadao.com.br': 'Estadão', 'diariodopoder.com.br': 'Diário do Poder', 'cartacapital.com.br': 'CartaCapital'
};

// ===================================================================================
// 4. CONFIGURAÇÃO DO SERVIÇO DE E-MAIL (MAILERSEND COM API TOKEN)
// ===================================================================================

const mailerSend = new MailerSend({
    // Usando o seu Token de API que você já forneceu.
    apiKey: 'mlsn.770c7ed9a708a78b05457668dca91d648cab51d4e1e68a5335fb810a471ecaec',
});

// IMPORTANTE: Defina aqui o e-mail e nome do remetente
// O e-mail DEVE ser de um domínio que você já verificou no MailerSend.
// Linha correta, usando o seu domínio de teste do MailerSend:
const sentFrom = new Sender("trial@test-nrw7gymv75jg2k8e.mlsender.net", "Newsletter do Pedro");

// ===================================================================================
// 5. FUNÇÕES PRINCIPAIS
// ===================================================================================
async function fetchNewsForTopic(topic) {
    let feeds = topicFeeds[topic.toLowerCase()];
    if (!feeds || feeds.length === 0) {
        console.log(`Tópico "${topic}" não predefinido. Usando busca padrão no Google News.`);
        feeds = [`https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=pt-BR&gl=BR&ceid=BR:pt`];
    }
    const parser = new Parser();
    let allArticles = [];
    const promises = feeds.map(async (url) => {
        try {
            const feed = await parser.parseURL(url);
            const articles = await Promise.all((feed.items || []).map(async (item) => ({
                title: item.title || 'Sem título',
                description: item.contentSnippet || item.content?.replace(/<[^>]*>?/gm, '') || 'Sem descrição',
                link: item.link,
                pubDate: item.pubDate,
                source: feed.title || await getSourceFromUrl(item.link, item.title),
                topic: topic
            })));
            allArticles.push(...articles);
        } catch (error) {
            console.error(`Falha ao buscar notícias de ${url}:`, error.message);
        }
    });
    await Promise.all(promises);
    const uniqueArticles = Array.from(new Map(allArticles.map(item => [item.link, item])).values());
    uniqueArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    return uniqueArticles.slice(0, 20);
}

async function getSourceFromUrl(link, title) {
    try {
        const response = await axios.get(link, { maxRedirects: 5, timeout: 7000 });
        const hostname = new URL(response.request.res.responseUrl).hostname.replace('www.', '');
        return sourceMap[hostname] || hostname;
    } catch (err) {
        return title.split(' - ').pop() || 'Fonte Desconhecida';
    }
}

async function updateAllNews() {
    console.log('Iniciando atualização de notícias...');
    const predefinedTopics = Object.keys(topicFeeds);
    const subscriberTopics = db.get('subscribers').map('topic').value();
    const allTopicsToUpdate = [...new Set([...predefinedTopics, ...subscriberTopics])];
    for (const topic of allTopicsToUpdate) {
        const articles = await fetchNewsForTopic(topic);
        if (articles.length > 0) {
            newsCache[topic] = articles;
        }
    }
    console.log('Atualização de notícias concluída.');
}

// ===================================================================================
// 6. CONFIGURAÇÃO DO SERVIDOR EXPRESS
// ===================================================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================================================
// 7. ROTAS DA APLICAÇÃO
// ===================================================================================

app.get('/', (req, res) => {
    const subscribers = db.get('subscribers').value();
    res.render('index', { subscribers });
});

app.post('/subscribe', async (req, res) => {
    const { topic, email } = req.body;
    if (!topic || !email) return res.status(400).send('Tópico e e-mail são obrigatórios!');
    const subscriber = { topic: topic.trim().toLowerCase(), email: email.trim().toLowerCase() };
    if (!db.get('subscribers').find(subscriber).value()) {
        db.get('subscribers').push({ ...subscriber, lastArticles: [] }).write();
        await updateAllNews();
    }
    res.redirect('/');
});

app.post('/unsubscribe', (req, res) => {
    db.get('subscribers').remove({ topic: req.body.topic, email: req.body.email }).write();
    res.redirect('/');
});

app.get('/reset-db', (req, res) => {
    db.setState({ subscribers: [], articles: [] }).write();
    newsCache = {};
    res.redirect('/');
});

app.get('/subscribe', (req, res) => {
    const { startDate, endDate, topic } = req.query;
    let articles = [].concat(...Object.values(newsCache));
    articles = Array.from(new Map(articles.map(a => [a.link, a])).values());
    const predefinedTopics = Object.keys(topicFeeds);
    const subscriberTopics = db.get('subscribers').map('topic').value();
    const allTopics = [...new Set([...predefinedTopics, ...subscriberTopics])].sort();
    if (topic) articles = articles.filter(a => a.topic.toLowerCase() === topic.toLowerCase());
    if (startDate) articles = articles.filter(a => new Date(a.pubDate) >= new Date(startDate));
    if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        articles = articles.filter(a => new Date(a.pubDate) <= end);
    }
    articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    res.render('subscribe', { articles, topics: allTopics, query: req.query });
});

app.post('/send-email', async (req, res) => {
    let { selectedArticles: selectedLinks } = req.body;
    if (!selectedLinks) return res.status(400).send('Nenhuma notícia selecionada!');
    if (!Array.isArray(selectedLinks)) selectedLinks = [selectedLinks];

    const allCachedArticles = [].concat(...Object.values(newsCache));
    const articlesToSend = allCachedArticles.filter(a => selectedLinks.includes(a.link));
    if (articlesToSend.length === 0) return res.status(400).send('Artigos selecionados não encontrados.');

    const subscribers = db.get('subscribers').value();
    if (subscribers.length === 0) return res.status(400).send('Nenhum assinante cadastrado.');

    const templatePath = path.join(__dirname, 'public', 'email-template.ejs');
    if (!fs.existsSync(templatePath)) return res.status(500).send('Erro: Template de e-mail não encontrado.');
    
    const htmlContent = await ejs.renderFile(templatePath, { articles: articlesToSend });
    
    const recipients = subscribers.map(sub => new Recipient(sub.email));
    const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject("Suas notícias selecionadas")
        .setHtml(htmlContent);

    try {
        await mailerSend.email.send(emailParams);
        console.log(`E-mails enviados para ${recipients.length} assinantes via MailerSend.`);
        res.send('E-mails enviados com sucesso!');
    } catch (error) {
        console.error('Falha ao enviar e-mails via MailerSend:', error.body);
        res.status(500).send("Erro ao enviar e-mails. Verifique o console do servidor.");
    }
});


// ===================================================================================
// 8. TAREFA AGENDADA (CRON JOB)
// ===================================================================================
cron.schedule('*/30 * * * *', async () => {
    console.log('CRON: Executando tarefa agendada...');
    await updateAllNews();
    const subscribers = db.get('subscribers').value();
    const templatePath = path.join(__dirname, 'public', 'email-template.ejs');
    if (!fs.existsSync(templatePath)) {
        console.error('CRON: Template de e-mail não encontrado.');
        return;
    }

    for (const sub of subscribers) {
        const articlesForTopic = newsCache[sub.topic] || [];
        if (articlesForTopic.length === 0) continue;
        const lastSentLinks = new Set((sub.lastArticles || []).map(a => a.link));
        const newArticles = articlesForTopic.filter(a => !lastSentLinks.has(a.link));

        if (newArticles.length > 0) {
            console.log(`CRON: Enviando ${newArticles.length} novas notícias sobre "${sub.topic}" para ${sub.email}`);
            const htmlContent = await ejs.renderFile(templatePath, { articles: newArticles });
            
            const recipients = [new Recipient(sub.email)];
            const emailParams = new EmailParams()
                .setFrom(sentFrom)
                .setTo(recipients)
                .setSubject(`Novas Notícias sobre ${sub.topic}`)
                .setHtml(htmlContent);

            try {
                await mailerSend.email.send(emailParams);
                console.log(`CRON: E-mail enviado com sucesso para ${sub.email}`);
                db.get('subscribers')
                  .find({ email: sub.email, topic: sub.topic })
                  .assign({ lastArticles: articlesForTopic.map(a => ({ link: a.link })) })
                  .write();
            } catch (error) {
                console.error(`CRON: Falha ao enviar e-mail para ${sub.email}:`, error.body);
            }
        } else {
             console.log(`CRON: Nenhuma notícia nova sobre "${sub.topic}" para ${sub.email}.`);
        }
    }
});


// ===================================================================================
// 9. INICIALIZAÇÃO DO SERVIDOR
// ===================================================================================
app.listen(port, async () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    await updateAllNews();
});