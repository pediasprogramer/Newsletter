// ===================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL (COMPLETO)
// ===================================================================================
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const Parser = require('rss-parser');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const ejs = require('ejs');
const axios = require('axios');

const app = express();
const port = 3000;

// ===================================================================================
// 2. BANCO DE DADOS (LOWDB) E CACHE (COMPLETO)
// ===================================================================================
const dbPath = path.join(__dirname, 'db.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);

// Estrutura completa do banco de dados, com inscritos e artigos
db.defaults({ subscribers: [], articles: [] }).write();
let newsCache = {};

// ===================================================================================
// 3. FONTES DE NOTÍCIAS E CONFIGURAÇÃO DE E-MAIL (ATUALIZADO)
// ===================================================================================
const topicFeeds = {
    'política': [ 'https://news.google.com/rss/search?q=política+brasil&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://www.poder360.com.br/feed/', 'https://www.cartacapital.com.br/feed/' ],
    'economia': [ 'https://news.google.com/rss/search?q=economia+brasil&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://g1.globo.com/rss/g1/economia/' ],
    'mundo':    [ 'https://news.google.com/rss/search?q=notícias+mundo&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://g1.globo.com/rss/g1/mundo/' ],
    'ciro nogueira': [ 'https://news.google.com/rss/search?q=Ciro+Nogueira&hl=pt-BR&gl=BR&ceid=BR:pt', 'https://www.diariodopoder.com.br/feed/' ]
};

// Configuração do MailerSend mantida
const mailerSend = new MailerSend({
    apiKey: 'mlsn.770c7ed9a708a78b05457668dca91d648cab51d4e1e68a5335fb810a471ecaec',
});
const sentFrom = new Sender("trial@test-nrw7gymv75jg2k8e.mlsender.net", "Newsletter do Pedro");

// ===================================================================================
// 5. FUNÇÕES PRINCIPAIS (COMPLETO)
// ===================================================================================

/**
 * Busca notícias para um tópico, incluindo a captura de imagens.
 */
async function fetchNewsForTopic(topic) {
    let feeds = topicFeeds[topic.toLowerCase()] || [`https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=pt-BR&gl=BR&ceid=BR:pt`];
    const parser = new Parser({
        customFields: { item: [['media:content', 'mediaContent']] },
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    let allArticles = [];
    for (const url of feeds) {
        try {
            const feed = await parser.parseURL(url);
            (feed.items || []).forEach(item => {
                let imageUrl = null;
                if (item.mediaContent?.$?.url) imageUrl = item.mediaContent.$.url;
                else if (item.enclosure?.url) imageUrl = item.enclosure.url;
                else if (item.content) {
                    const match = item.content.match(/<img[^>]+src="([^">]+)"/);
                    if (match) imageUrl = match[1];
                }
                allArticles.push({
                    title: item.title || 'Sem título',
                    description: item.contentSnippet || item.content?.replace(/<[^>]*>?/gm, '') || 'Sem descrição',
                    link: item.link, pubDate: item.pubDate, source: feed.title || new URL(item.link).hostname.replace('www.', ''),
                    topic: topic, image: imageUrl
                });
            });
        } catch (error) { console.error(`Falha ao buscar notícias de ${url}:`, error.message); }
    }
    const uniqueArticles = Array.from(new Map(allArticles.map(item => [item.link, item])).values());
    uniqueArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    return uniqueArticles.slice(0, 50);
}

/**
 * Atualiza o cache de notícias para todos os tópicos inscritos.
 */
async function updateAllNews() {
    console.log('Iniciando atualização de notícias para o cache...');
    const subscriberTopics = db.get('subscribers').map('topic').value();
    const allTopicsToUpdate = [...new Set([...Object.keys(topicFeeds), ...subscriberTopics])];
    for (const topic of allTopicsToUpdate) {
        const articles = await fetchNewsForTopic(topic);
        if (articles.length > 0) {
            newsCache[topic] = articles;
        }
    }
    console.log('Atualização de notícias do cache concluída.');
}

// ===================================================================================
// 6. CONFIGURAÇÃO DO SERVIDOR EXPRESS (COMPLETO)
// ===================================================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// ===================================================================================
// 7. ROTAS DA APLICAÇÃO (ROTA PRINCIPAL ATUALIZADA)
// ===================================================================================

// ROTA PRINCIPAL: Renderiza o painel com temas fixos e o tema pesquisado.
app.get('/', async (req, res) => {
    const { topic, startDate, endDate } = req.query;
    const mandatoryTopics = ['política', 'economia', 'mundo'];
    let topicsToFetch = [...mandatoryTopics];
    let articlesByTopic = {};
    
    // Adiciona o tópico pesquisado (se houver e não for um dos obrigatórios)
    if (topic && !mandatoryTopics.includes(topic.toLowerCase())) {
        topicsToFetch.push(topic);
    }

    try {
        // Busca notícias para todos os tópicos em paralelo
        const promises = topicsToFetch.map(async (t) => {
            let articles = await fetchNewsForTopic(t);

            // Aplica filtros de data se existirem
            if (startDate) articles = articles.filter(a => new Date(a.pubDate) >= new Date(startDate));
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                articles = articles.filter(a => new Date(a.pubDate) <= end);
            }
            
            // Adiciona ao objeto final, mesmo que esteja vazio
            articlesByTopic[t] = articles;
        });
        
        await Promise.all(promises);

    } catch (error) {
        console.error("Erro ao buscar notícias:", error);
        // Em caso de erro, inicializa com arrays vazios para não quebrar a página
        mandatoryTopics.forEach(t => {
            if (!articlesByTopic[t]) articlesByTopic[t] = [];
        });
    }
    
    // Passa os dados corretos para o template
    res.render('index', { 
        articlesByTopic, 
        query: req.query, 
        topics: Object.keys(articlesByTopic) // AQUI ESTÁ A VARIÁVEL 'topics' QUE FALTAVA
    });
});


// ROTA PARA INSCRIÇÃO (FUNCIONALIDADE MANTIDA NO BACKEND)
app.post('/subscribe', async (req, res) => {
    const { topic, email } = req.body;
    if (!topic || !email) return res.status(400).send('Tópico e e-mail são obrigatórios!');
    const subscriber = { topic: topic.trim().toLowerCase(), email: email.trim().toLowerCase() };
    if (!db.get('subscribers').find(subscriber).value()) {
        db.get('subscribers').push({ ...subscriber, lastArticles: [] }).write();
        await updateAllNews(); // Atualiza notícias para o novo tópico
    }
    res.status(200).send(`E-mail ${email} inscrito no tópico ${topic} com sucesso!`);
});

// ROTA PARA CANCELAR INSCRIÇÃO (FUNCIONALIDADE MANTIDA NO BACKEND)
app.post('/unsubscribe', (req, res) => {
    db.get('subscribers').remove({ topic: req.body.topic, email: req.body.email }).write();
    res.status(200).send('Inscrição removida com sucesso!');
});

// ROTA PARA RESETAR O BANCO DE DADOS (FUNCIONALIDADE MANTIDA)
app.get('/reset-db', (req, res) => {
    db.setState({ subscribers: [], articles: [] }).write();
    newsCache = {};
    res.send('Banco de dados de inscrições resetado.');
});

// ROTA PARA ENVIO DE E-MAIL (FUNCIONALIDADE MANTIDA NO BACKEND)
app.post('/send-email', async (req, res) => {
    let { selectedLinks, recipientEmails } = req.body;

    if (!selectedLinks || !recipientEmails) return res.status(400).send('Links de artigos e e-mails dos destinatários são obrigatórios!');
    if (!Array.isArray(selectedLinks)) selectedLinks = [selectedLinks];
    if (!Array.isArray(recipientEmails)) recipientEmails = [recipientEmails];

    const allCachedArticles = [].concat(...Object.values(newsCache));
    const articlesToSend = allCachedArticles.filter(a => selectedLinks.includes(a.link));
    if (articlesToSend.length === 0) return res.status(400).send('Artigos selecionados não encontrados no cache.');
    
    const templatePath = path.join(__dirname, 'public', 'email-template.ejs');
    if (!fs.existsSync(templatePath)) return res.status(500).send('Erro: Template de e-mail não encontrado.');
    const htmlContent = await ejs.renderFile(templatePath, { articles: articlesToSend });

    const recipients = recipientEmails.map(email => new Recipient(email));
    const emailParams = new EmailParams().setFrom(sentFrom).setTo(recipients).setSubject("Suas notícias selecionadas").setHtml(htmlContent);

    try {
        await mailerSend.email.send(emailParams);
        res.send(`E-mails enviados com sucesso para ${recipientEmails.join(', ')}!`);
    } catch (error) {
        console.error('Falha ao enviar e-mails via MailerSend:', error.body || error);
        res.status(500).send("Erro ao enviar e-mails.");
    }
});


// ===================================================================================
// 8. TAREFA AGENDADA (CRON JOB) - FUNCIONALIDADE COMPLETA MANTIDA
// ===================================================================================
cron.schedule('*/30 * * * *', async () => {
    console.log('CRON: Executando tarefa agendada de envio de notícias...');
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
            const emailParams = new EmailParams().setFrom(sentFrom).setTo([new Recipient(sub.email)]).setSubject(`Novas Notícias sobre ${sub.topic}`).setHtml(htmlContent);

            try {
                await mailerSend.email.send(emailParams);
                db.get('subscribers').find({ email: sub.email, topic: sub.topic }).assign({ lastArticles: articlesForTopic.map(a => ({ link: a.link })) }).write();
            } catch (error) { console.error(`CRON: Falha ao enviar e-mail para ${sub.email}:`, error.body || error); }
        }
    }
});

// ===================================================================================
// 9. INICIALIZAÇÃO DO SERVIDOR (COMPLETO)
// ===================================================================================
app.listen(port, async () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    // Carrega notícias iniciais ao iniciar o servidor
    if (Object.keys(newsCache).length === 0) {
        await updateAllNews();
    }
});