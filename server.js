const { TikTokLiveConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    allowEIO3: true
});

// اسم حساب صاحب البث
const TARGET_USERNAME = "a_7_m_d2";

app.use(express.static(path.join(__dirname, 'public')));

// ==================== الاتصال بقاعدة بيانات MongoDB (تخزين دائم) ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://falconabd91_db_user:I7TBT8VKdM5Zr7JV@cluster0.cvlkw88.mongodb.net/?appName=Cluster0";
const mongoClient = new MongoClient(MONGO_URI);
let db = null;
let customSectionsCollection = null;
let dbReady = false;

async function connectDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("tiktok_quiz");
        customSectionsCollection = db.collection("customSections");
        console.log('✅ متصل بقاعدة بيانات MongoDB بنجاح');
        await loadCustomSectionsFromDB();
        dbReady = true;
        broadcastSectionsLists(); // تحديث أي لوحات تحكم متصلة مسبقاً بالبيانات المحمّلة فعلياً
    } catch (err) {
        console.error('❌ فشل الاتصال بقاعدة البيانات:', err.toString());
    }
}

// تحميل الأقسام الخاصة المحفوظة من قاعدة البيانات عند بدء تشغيل السيرفر
async function loadCustomSectionsFromDB() {
    if (!customSectionsCollection) return;
    const doc = await customSectionsCollection.findOne({ _id: "sections" });
    if (doc && doc.data) {
        customSections = doc.data;
        // ضبط عدادات المعرّفات لتفادي تكرار id عند إضافة أقسام/أسئلة جديدة
        Object.values(customSections).forEach(sec => {
            if (sec.id >= customSectionIdCounter) customSectionIdCounter = sec.id + 1;
            (sec.questions || []).forEach(q => {
                if (q.id >= customQuestionIdCounter) customQuestionIdCounter = q.id + 1;
            });
        });
        console.log(`📂 تم تحميل ${Object.keys(customSections).length} قسم خاص من قاعدة البيانات`);
    }
}

// حفظ الأقسام الخاصة بالكامل في قاعدة البيانات (يُستدعى بعد أي تعديل)
async function saveCustomSectionsToDB() {
    if (!customSectionsCollection) return;
    try {
        await customSectionsCollection.updateOne(
            { _id: "sections" },
            { $set: { data: customSections } },
            { upsert: true }
        );
    } catch (err) {
        console.error('❌ خطأ أثناء حفظ الأقسام الخاصة:', err.toString());
    }
}

// ==================== بنك الأسئلة الثابتة (من الكود فقط) ====================
// كل قسم له نوع واحد ثابت: 'direct' (مباشر) أو 'choices' (خيارات)
let questionBank = {
    "عام": {
        type: "direct",
        questions: [
            { text: "من هو مصمم هذه الفعالية؟", correctAnswer: "جمال كوريني" }
        ]
    },
    "إسلاميات": {
        type: "direct",
        questions: [
            { text: "ما هي السورة التي تُسمى بـ \"قلب القرآن\"؟", correctAnswer: "يس" },
            { text: "من هو أول الخلفاء الراشدين؟", correctAnswer: "أبو بكر الصديق" },
            { text: "كم عدد سور القرآن الكريم؟", correctAnswer: "114" },
            { text: "ما هي الغزوة التي سُميت بـ \"يوم الفرقان\"؟", correctAnswer: "غزوة بدر" },
            { text: "من هو النبي الذي ابتلعه الحوت؟", correctAnswer: "يونس" },
            { text: "في أي شهر نزل القرآن الكريم؟", correctAnswer: "رمضان" },
            { text: "ما هي أطول سورة في القرآن الكريم؟", correctAnswer: "البقرة" },
            { text: "من هي المرأة التي لُقبت بـ \"ذات النطاقين\"؟", correctAnswer: "أسماء بنت أبي بكر" },
            { text: "ما هو أول مسجد بُني في الإسلام؟", correctAnswer: "مسجد قباء" },
            { text: "من هو الصحابي الجليل الذي لُقب بـ \"سيف الله المسلول\"؟", correctAnswer: "خالد بن الوليد" }
        ]
    }
};

// ==================== الأقسام الخاصة (يديرها الأدمن، تُحفظ في الذاكرة) ====================
let customSections = {};
let customSectionIdCounter = 1;
let customQuestionIdCounter = 1;

// ==================== حالة النظام العامة ====================
let state = {
    teamMode: false,
    registrationOpen: false,
    teams: { م1: [], م2: [] },

    drawMode: false,
    drawKeyword: null,
    drawParticipants: [],

    competitionActive: false,
    competitionSource: null,
    competitionSectionName: null,
    competitionType: null,
    competitionDuration: null,
    competitionTotalQuestions: null,
    competitionAskedCount: 0,
    competitionRemainingIndexes: [],
    currentQuestion: null,
    currentCorrectAnswer: null,
    roundActive: false,
    roundStartTime: null,
    correctAnswersThisQuestion: [],
    competitionCorrectCounts: {},
    competitionFinished: false,

    scores: {},
    teamScores: { م1: 0, م2: 0 }
};

let questionTimer = null;

// ==================== أدوات مساعدة: مطابقة الإجابات ====================
function normalizeAnswer(str) {
    return (str || '')
        .trim()
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[\u064B-\u065F]/g, '')
        .replace(/[.,،؟!"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const TRAILING_PHRASES = [
    'رضي الله عنه وعنها', 'رضي الله عنهما', 'رضي الله عنهم',
    'رضي الله عنه', 'رضي الله عنها',
    'عليه الصلاة والسلام', 'عليه السلام', 'صلى الله عليه وسلم'
];
const TRAILING_WORDS = ['سورة', 'سوره', 'غزوة', 'غزوه'];

function extractCoreAnswer(rawAnswer) {
    let core = normalizeAnswer(rawAnswer);
    for (const phrase of TRAILING_PHRASES) {
        core = core.replace(normalizeAnswer(phrase), '').trim();
    }
    const words = core.split(' ').filter(Boolean);
    const filtered = words.filter(w => !TRAILING_WORDS.includes(w));
    core = filtered.length > 0 ? filtered.join(' ') : core;
    return core.trim();
}

function isAnswerCorrect(userComment, correctRawAnswer) {
    const userAnswer = normalizeAnswer(userComment);
    if (!userAnswer) return false;

    const core = extractCoreAnswer(correctRawAnswer);
    const fullCorrect = normalizeAnswer(correctRawAnswer);

    if (userAnswer === fullCorrect || userAnswer === core) return true;
    if (core.length >= 2 && userAnswer.includes(core)) return true;

    const coreWords = core.split(' ').filter(Boolean);
    const userWords = userAnswer.split(' ').filter(Boolean);
    if (coreWords.length > 1 && userWords.length >= 1) {
        const prefix = coreWords.slice(0, userWords.length).join(' ');
        if (userWords.length < coreWords.length && userAnswer === prefix && prefix.length >= 3) {
            return true;
        }
    }
    return false;
}

function isChoiceCorrect(userComment, choices, correctIndex) {
    const userAnswer = normalizeAnswer(userComment);
    if (!userAnswer) return false;

    const numMatch = userAnswer.match(/^([1-4])$/);
    if (numMatch) {
        return (parseInt(numMatch[1], 10) - 1) === correctIndex;
    }

    return isAnswerCorrect(userComment, choices[correctIndex]);
}

// ==================== بث الحالة ====================
function broadcastState() {
    io.emit('stateUpdate', state);
}

function broadcastSectionsLists() {
    const bankSectionNames = Object.keys(questionBank).map(name => ({
        name, type: questionBank[name].type, count: questionBank[name].questions.length
    }));
    io.emit('sectionsUpdate', {
        bankSections: bankSectionNames,
        customSections: customSections
    });
}

function broadcastLeaderboard() {
    if (state.teamMode) {
        io.emit('leaderboardUpdate', { teamMode: true, teamScores: state.teamScores });
    } else {
        const sorted = Object.entries(state.scores)
            .sort((a, b) => b[1] - a[1])
            .map(([name, points]) => ({ name, points }));
        io.emit('leaderboardUpdate', { teamMode: false, scores: sorted });
    }
}

function addPoints(name, team, amount) {
    if (state.teamMode && team) {
        state.teamScores[team] = (state.teamScores[team] || 0) + amount;
    } else if (!state.teamMode) {
        state.scores[name] = (state.scores[name] || 0) + amount;
    }
}

function getPlayerTeam(name) {
    if (state.teams["م1"].includes(name)) return "م1";
    if (state.teams["م2"].includes(name)) return "م2";
    return null;
}

function getSectionQuestions(source, sectionName) {
    if (source === 'bank') {
        return questionBank[sectionName] ? questionBank[sectionName].questions : [];
    } else {
        return customSections[sectionName] ? customSections[sectionName].questions : [];
    }
}

function getSectionType(source, sectionName) {
    if (source === 'bank') {
        return questionBank[sectionName] ? questionBank[sectionName].type : null;
    } else {
        return customSections[sectionName] ? customSections[sectionName].type : null;
    }
}

function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ==================== منطق المسابقة (أسئلة وأجوبة) ====================
function startCompetition(source, sectionName, duration, totalQuestions) {
    const questions = getSectionQuestions(source, sectionName);
    const type = getSectionType(source, sectionName);
    if (!questions || questions.length === 0) return false;

    const actualTotal = Math.min(totalQuestions, questions.length);
    const indexes = shuffleArray(questions.map((_, i) => i)).slice(0, actualTotal);

    state.competitionActive = true;
    state.competitionSource = source;
    state.competitionSectionName = sectionName;
    state.competitionType = type;
    state.competitionDuration = duration;
    state.competitionTotalQuestions = actualTotal;
    state.competitionAskedCount = 0;
    state.competitionRemainingIndexes = indexes;
    state.competitionCorrectCounts = {};
    state.competitionFinished = false;
    state.currentQuestion = null;
    state.roundActive = false;

    broadcastState();
    askNextQuestion();
    return true;
}

function askNextQuestion() {
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }

    if (state.competitionRemainingIndexes.length === 0) {
        finishCompetition();
        return;
    }

    const questions = getSectionQuestions(state.competitionSource, state.competitionSectionName);
    const idx = state.competitionRemainingIndexes.shift();
    const q = questions[idx];

    state.competitionAskedCount += 1;
    state.correctAnswersThisQuestion = [];
    state.roundStartTime = Date.now();
    state.roundActive = true;

    if (state.competitionType === 'choices') {
        state.currentQuestion = { text: q.text, choices: q.choices };
        state.currentCorrectAnswer = { choices: q.choices, correctIndex: q.correctIndex };
    } else {
        state.currentQuestion = { text: q.text };
        state.currentCorrectAnswer = { text: q.correctAnswer };
    }

    broadcastState();

    questionTimer = setTimeout(() => {
        state.roundActive = false;
        broadcastState();
        setTimeout(askNextQuestion, 2000);
    }, state.competitionDuration * 1000);
}

function finishCompetition() {
    state.competitionActive = false;
    state.competitionFinished = true;
    state.roundActive = false;
    state.currentQuestion = null;
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
    broadcastState();
    broadcastLeaderboard();
}

function stopCompetitionManually() {
    state.competitionActive = false;
    state.competitionFinished = false;
    state.roundActive = false;
    state.currentQuestion = null;
    state.competitionSource = null;
    state.competitionSectionName = null;
    state.competitionRemainingIndexes = [];
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
    broadcastState();
}

// ==================== منطق الاتصال بلوحة التحكم (Socket.io) ====================
io.on('connection', (socket) => {
    console.log('📶 لوحة تحكم جديدة متصلة');
    socket.emit('stateUpdate', state);
    broadcastSectionsLists();
    broadcastLeaderboard();

    socket.on('createCustomSection', (payload) => {
        const name = (payload.name || '').trim();
        if (!name || customSections[name]) return;
        customSections[name] = {
            id: customSectionIdCounter++,
            type: payload.type === 'choices' ? 'choices' : 'direct',
            questions: []
        };
        broadcastSectionsLists();
        saveCustomSectionsToDB();
    });

    socket.on('deleteCustomSection', (sectionName) => {
        delete customSections[sectionName];
        broadcastSectionsLists();
        saveCustomSectionsToDB();
    });

    socket.on('addCustomQuestion', (payload) => {
        const section = customSections[payload.sectionName];
        if (!section) return;

        if (section.type === 'direct') {
            section.questions.push({
                id: customQuestionIdCounter++,
                text: payload.text,
                correctAnswer: payload.correctAnswer
            });
        } else {
            section.questions.push({
                id: customQuestionIdCounter++,
                text: payload.text,
                choices: payload.choices,
                correctIndex: payload.correctIndex
            });
        }
        broadcastSectionsLists();
        saveCustomSectionsToDB();
    });

    socket.on('editCustomQuestion', (payload) => {
        const section = customSections[payload.sectionName];
        if (!section) return;
        const q = section.questions.find(q => q.id === payload.questionId);
        if (!q) return;

        q.text = payload.text;
        if (section.type === 'direct') {
            q.correctAnswer = payload.correctAnswer;
        } else {
            q.choices = payload.choices;
            q.correctIndex = payload.correctIndex;
        }
        broadcastSectionsLists();
        saveCustomSectionsToDB();
    });

    socket.on('deleteCustomQuestion', (payload) => {
        const section = customSections[payload.sectionName];
        if (!section) return;
        section.questions = section.questions.filter(q => q.id !== payload.questionId);
        broadcastSectionsLists();
        saveCustomSectionsToDB();
    });

    socket.on('toggleRegistration', (isOpen) => {
        state.registrationOpen = isOpen;
        if (isOpen) {
            state.teams = { م1: [], م2: [] };
        }
        broadcastState();
    });

    socket.on('setTeamMode', (isTeamMode) => {
        state.teamMode = isTeamMode;
        broadcastState();
    });

    socket.on('startCompetition', (payload) => {
        startCompetition(payload.source, payload.sectionName, payload.duration, payload.totalQuestions);
    });

    socket.on('stopCompetition', () => {
        stopCompetitionManually();
    });

    socket.on('dismissFinalResults', () => {
        state.competitionFinished = false;
        state.competitionCorrectCounts = {};
        broadcastState();
    });

    socket.on('startDraw', (payload) => {
        state.drawKeyword = payload.keyword;
        state.drawParticipants = [];
        state.drawMode = true;
        broadcastState();
    });

    socket.on('stopDrawCollection', () => {
        state.drawMode = false;
        io.emit('drawCollectionStopped', state.drawParticipants);
        broadcastState();
    });

    socket.on('pickDrawWinner', () => {
        if (state.drawParticipants.length === 0) return;
        const winner = state.drawParticipants[Math.floor(Math.random() * state.drawParticipants.length)];
        addPoints(winner, getPlayerTeam(winner), 1);
        io.emit('drawWinnerPicked', winner);
        broadcastLeaderboard();
    });

    socket.on('resetScoresOnly', () => {
        state.scores = {};
        state.teamScores = { م1: 0, م2: 0 };
        broadcastLeaderboard();
    });

    socket.on('resetAll', () => {
        if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
        state = {
            teamMode: false,
            registrationOpen: false,
            teams: { م1: [], م2: [] },
            drawMode: false,
            drawKeyword: null,
            drawParticipants: [],
            competitionActive: false,
            competitionSource: null,
            competitionSectionName: null,
            competitionType: null,
            competitionDuration: null,
            competitionTotalQuestions: null,
            competitionAskedCount: 0,
            competitionRemainingIndexes: [],
            currentQuestion: null,
            currentCorrectAnswer: null,
            roundActive: false,
            roundStartTime: null,
            correctAnswersThisQuestion: [],
            competitionCorrectCounts: {},
            competitionFinished: false,
            scores: {},
            teamScores: { م1: 0, م2: 0 }
        };
        broadcastState();
        broadcastLeaderboard();
    });
});

// ==================== الاتصال ببث TikTok ====================
let tiktokConnection = new TikTokLiveConnection(TARGET_USERNAME, {
    requestOptions: { timeout: 10000 },
    websocketOptions: { timeout: 10000 }
});

const processedMessages = new Set();

tiktokConnection.on('chat', (data) => {
    if (!data) return;
    const msgId = data.msgId || (data.msg && data.msg.id);
    if (msgId && processedMessages.has(msgId)) return;
    if (msgId) processedMessages.add(msgId);

    const nickname = data.nickname || (data.user && data.user.nickname) || 'unknown';
    const comment = (data.comment || data.text || data.content || '').trim();
    if (!comment) return;

    if (state.registrationOpen) {
        const clean = comment.replace(/\s+/g, '');
        if (clean === 'م1' && !state.teams["م1"].includes(nickname) && !state.teams["م2"].includes(nickname)) {
            state.teams["م1"].push(nickname);
            broadcastState();
            return;
        }
        if (clean === 'م2' && !state.teams["م2"].includes(nickname) && !state.teams["م1"].includes(nickname)) {
            state.teams["م2"].push(nickname);
            broadcastState();
            return;
        }
    }

    if (state.drawMode && state.drawKeyword) {
        if (comment.includes(state.drawKeyword) && !state.drawParticipants.includes(nickname)) {
            state.drawParticipants.push(nickname);
            io.emit('drawParticipantsUpdate', state.drawParticipants);
        }
        return;
    }

    if (state.roundActive && state.currentQuestion && state.currentCorrectAnswer) {
        const team = getPlayerTeam(nickname);
        if (state.teamMode && !team) return;

        const alreadyAnswered = state.correctAnswersThisQuestion.includes(nickname);
        if (alreadyAnswered) return;

        let correct = false;
        if (state.competitionType === 'choices') {
            correct = isChoiceCorrect(comment, state.currentCorrectAnswer.choices, state.currentCorrectAnswer.correctIndex);
        } else {
            correct = isAnswerCorrect(comment, state.currentCorrectAnswer.text);
        }

        if (correct) {
            state.correctAnswersThisQuestion.push(nickname);
            state.competitionCorrectCounts[nickname] = (state.competitionCorrectCounts[nickname] || 0) + 1;
            addPoints(nickname, team, 1);
            io.emit('newCorrectAnswer', { name: nickname, team: team || null });
            broadcastLeaderboard();
        }
    }
});

function runServer() {
    console.log('🔄 جاري فحص حالة البث في الخلفية...');
    tiktokConnection.waitUntilLive(30)
        .then(() => {
            console.log('🚀 الحساب نشط الآن! جاري بدء الاتصال...');
            return tiktokConnection.connect();
        })
        .then(() => {
            console.log('✅ متصل بنجاح ببث تيك توك!');
        })
        .catch((err) => {
            console.error('❌ تنبيه في الخلفية (سيتم إعادة المحاولة تلقائياً):', err.toString());
            setTimeout(runServer, 30000);
        });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ: ${PORT}`);
    connectDB();
    runServer();
});
