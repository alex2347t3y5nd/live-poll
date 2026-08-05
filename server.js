const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

// Хранилище сессий в памяти
const sessions = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== REST API ==========

// Создать новую сессию
app.post('/api/session', (req, res) => {
  const code = generateCode();
  sessions.set(code, { questions: [], activeQuestionId: null, answers: new Map() });
  res.json({ code });
});

// Создать новый вопрос в сессии и сделать его активным
app.post('/api/question', (req, res) => {
  const { code, question, type, options } = req.body;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const id = Date.now().toString(36);
  const newQuestion = {
    id,
    question,
    type: type || 'choice',
    options: options || [],
    wordcloud: type === 'wordcloud' ? {} : undefined
  };

  session.questions.push(newQuestion);
  session.activeQuestionId = id;
  session.answers.set(id, type === 'wordcloud' ? {} : {});

  // Оповестить участников
  broadcastToSession(code, {
    type: 'new_question',
    question: { id, question, type: newQuestion.type, options: newQuestion.options }
  }, 'participant');

  // Оповестить экраны демонстрации
  broadcastToSession(code, {
    type: 'display_question',
    question: { id, question, type: newQuestion.type, options: newQuestion.options },
    results: {}
  }, 'display');

  res.json({ questionId: id });
});

// Отправить ответ
app.post('/api/answer', (req, res) => {
  const { code, questionId, option } = req.body;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const question = session.questions.find(q => q.id === questionId);
  if (!question) return res.status(404).json({ error: 'Question not found' });

  if (question.type === 'choice') {
    const answers = question.wordcloud || {};
    answers[option] = (answers[option] || 0) + 1;
    question.wordcloud = answers;
  } else if (question.type === 'wordcloud') {
    const words = session.answers.get(questionId) || {};
    const normalizedWord = option.trim().toLowerCase();
    if (normalizedWord.length > 0) {
      words[normalizedWord] = (words[normalizedWord] || 0) + 1;
    }
  }

  const results = question.type === 'wordcloud'
    ? session.answers.get(questionId)
    : (question.wordcloud || session.answers.get(questionId));

  // Отправить результаты ведущим
  broadcastToSession(code, {
    type: 'results',
    questionId,
    questionType: question.type,
    results
  }, 'presenter');

  // Отправить результаты экранам демонстрации
  broadcastToSession(code, {
    type: 'display_results',
    questionType: question.type,
    results
  }, 'display');

  // Для wordcloud также шлём обновление участникам
  if (question.type === 'wordcloud') {
    broadcastToSession(code, {
      type: 'wordcloud_update',
      questionId,
      words: results
    }, 'participant');
  }

  res.json({ success: true });
});

// Получить текущий активный вопрос
app.get('/api/session/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.json({ active: null });

  const activeQuestion = session.questions.find(q => q.id === session.activeQuestionId);
  if (!activeQuestion) return res.json({ code: req.params.code, activeQuestion: null });

  res.json({
    code: req.params.code,
    activeQuestion: {
      id: activeQuestion.id,
      question: activeQuestion.question,
      type: activeQuestion.type,
      options: activeQuestion.options
    },
    wordcloud: activeQuestion.type === 'wordcloud'
      ? session.answers.get(activeQuestion.id)
      : null
  });
});

// Получить историю всех вопросов и результатов сессии (для экспорта)
app.get('/api/session/:code/history', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const history = session.questions.map(q => {
    const answers = q.type === 'wordcloud'
      ? session.answers.get(q.id)
      : (q.wordcloud || session.answers.get(q.id));
    return {
      id: q.id,
      question: q.question,
      type: q.type,
      options: q.options,
      answers: answers || {}
    };
  });

  res.json({ code: req.params.code, questions: history });
});

// Отдаём страницу участника по короткой ссылке
app.get('/join', (req, res) => {
  const session = req.query.session ? `?session=${encodeURIComponent(req.query.session)}` : '';
  res.redirect(`/participant.html${session}`);
});

// ========== WebSocket ==========

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const role = urlParams.get('role');
  const code = urlParams.get('session');

  if (!code || !role) {
    ws.close();
    return;
  }

  ws.sessionCode = code;
  ws.role = role;

  // Если подключился display — отправляем ему текущий вопрос и результаты
  if (role === 'display') {
    const session = sessions.get(code);
    if (session && session.activeQuestionId) {
      const activeQuestion = session.questions.find(q => q.id === session.activeQuestionId);
      if (activeQuestion) {
        const results = activeQuestion.type === 'wordcloud'
          ? session.answers.get(session.activeQuestionId) || {}
          : (activeQuestion.wordcloud || session.answers.get(session.activeQuestionId) || {});

        ws.send(JSON.stringify({
          type: 'display_question',
          question: {
            id: activeQuestion.id,
            question: activeQuestion.question,
            type: activeQuestion.type,
            options: activeQuestion.options
          },
          results: results
        }));
      }
    }
  }
});

function broadcastToSession(code, message, targetRole) {
  wss.clients.forEach(client => {
    if (
      client.readyState === WebSocket.OPEN &&
      client.sessionCode === code &&
      client.role === targetRole
    ) {
      client.send(JSON.stringify(message));
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Прототип запущен на http://localhost:${PORT}`);
  console.log(`Панель ведущего: http://localhost:${PORT}/presenter.html`);
  console.log(`Страница демонстрации: http://localhost:${PORT}/display.html?session=КОД_СЕССИИ`);
});
