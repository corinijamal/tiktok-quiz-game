const { TikTokLiveConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    allowEIO3: true
});

// اسم حساب صاحب البث
const TARGET_USERNAME = "a_7_m_d2";

app.use(express.static(path.join(__dirname, 'public')));

// ==================== حالة النظام العامة ====================
let state = {
    mode: null,              // 'idle' | 'qna' | 'race' | 'draw' | null
    teamMode: false,         // false = فردي, true = مجموعات
    registrationOpen: false, // فتح تسجيل المجموعات (م1/م2) قبل بدء الجولة
    teams: { م1: [], م2: [] }, // أعضاء كل مجموعة (فردي وأسماء)
    currentQuestion: null,   // { text, type: 'direct'|'choices', choices: [], correctAnswer, duration }
    roundActive: false,      // هل الجولة قيد التشغيل فعلياً (استقبال إجابات)
    correctAnswers: [],      // [{ name, team }] بترتيب وصولهم
    roundStartTime: null,
    scores: {},              // { playerName: points } وضع فردي
    teamScores: { م1: 0, م2: 0 }, // وضع مجموعات
    drawParticipants: [],    // أسماء المشاركين بالسحب العشوائي
    drawKeyword: null
};

// بنك الأسئلة الثابتة (أقسام) - سيُملأ لاحقاً من ملفات Word
let questionBank = {
    "عام": [
        { text: "من هو مصمم هذه الفعالية؟", type: "direct", correctAnswer: "جمال كوريني" }
    ]
};

// ==================== أدوات مساعدة ====================
function normalizeAnswer(str) {
    return (str || '')
        .trim()
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[\u064B-\u065F]/g, '') // إزالة التشكيل
        .replace(/\s+/g, ' ');
}

function broadcastState() {
    io.emit('stateUpdate', state);
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

// ==================== منطق الاتصال بلوحة التحكم (Socket.io) ====================
io.on('connection', (socket) => {
    console.log('📶 لوحة تحكم جديدة متصلة');
    socket.emit('stateUpdate', state);
    socket.emit('questionBankUpdate', questionBank);
    broadcastLeaderboard();

    // ---- التسجيل في المجموعات ----
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

    // ---- بدء سؤال (من بنك الأسئلة أو سؤال خاص) ----
    socket.on('startQuestion', (payload) => {
        // payload: { text, type, choices, correctAnswer, duration }
        state.currentQuestion = {
            text: payload.text,
            type: payload.type || 'direct',
            choices: payload.choices || [],
            correctAnswer: payload.correctAnswer,
            duration: payload.duration || 20
        };
        state.roundActive = true;
        state.correctAnswers = [];
        state.roundStartTime = Date.now();
        state.registrationOpen = false; // إقفال تسجيل المجموعات بمجرد بدء أي جولة
        state.mode = 'qna';

        io.emit('questionStarted', state.currentQuestion);
        broadcastState();

        // إنهاء الجولة تلقائياً بعد المدة المحددة
        setTimeout(() => {
            if (state.roundActive && state.currentQuestion && state.roundStartTime) {
                endRound();
            }
        }, state.currentQuestion.duration * 1000);
    });

    socket.on('endRoundManually', () => {
        endRound();
    });

    function endRound() {
        state.roundActive = false;
        io.emit('roundEnded', {
            correctAnswer: state.currentQuestion ? state.currentQuestion.correctAnswer : '',
            correctAnswers: state.correctAnswers,
            teamMode: state.teamMode,
            teamScores: state.teamScores
        });
        broadcastState();
        broadcastLeaderboard();
    }

    // ---- سباق الكتابة ----
    socket.on('startRace', (payload) => {
        // payload: { targetPhrase, duration }
        state.currentQuestion = {
            text: `اكتب: ${payload.targetPhrase}`,
            type: 'race',
            correctAnswer: payload.targetPhrase,
            duration: payload.duration || 20
        };
        state.roundActive = true;
        state.correctAnswers = [];
        state.roundStartTime = Date.now();
        state.registrationOpen = false;
        state.mode = 'race';

        io.emit('questionStarted', state.currentQuestion);
        broadcastState();

        setTimeout(() => {
            if (state.roundActive && state.currentQuestion && state.roundStartTime) {
                endRound();
            }
        }, state.currentQuestion.duration * 1000);
    });

    // ---- السحب العشوائي ----
    socket.on('startDraw', (payload) => {
        // payload: { keyword }
        state.drawKeyword = payload.keyword;
        state.drawParticipants = [];
        state.mode = 'draw';
        state.registrationOpen = false;
        broadcastState();
    });

    socket.on('stopDrawCollection', () => {
        io.emit('drawCollectionStopped', state.drawParticipants);
    });

    socket.on('pickDrawWinner', () => {
        if (state.drawParticipants.length === 0) return;
        const winner = state.drawParticipants[Math.floor(Math.random() * state.drawParticipants.length)];
        addPoints(winner, getPlayerTeam(winner), 1);
        io.emit('drawWinnerPicked', winner);
        broadcastLeaderboard();
    });

    // ---- إعادة تعيين كاملة ----
    socket.on('resetAll', () => {
        state = {
            mode: null,
            teamMode: false,
            registrationOpen: false,
            teams: { م1: [], م2: [] },
            currentQuestion: null,
            roundActive: false,
            correctAnswers: [],
            roundStartTime: null,
            scores: {},
            teamScores: { م1: 0, م2: 0 },
            drawParticipants: [],
            drawKeyword: null
        };
        broadcastState();
        broadcastLeaderboard();
    });

    socket.on('resetScoresOnly', () => {
        state.scores = {};
        state.teamScores = { م1: 0, م2: 0 };
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

    // ---- تسجيل المجموعات (م1 / م2) ----
    if (state.registrationOpen) {
        const clean = comment.replace(/\s+/g, '');
        if (clean === 'م1' && !state.teams["م1"].includes(nickname) && !state.teams["م2"].includes(nickname)) {
            state.teams["م1"].push(nickname);
            io.emit('stateUpdate', state);
            return;
        }
        if (clean === 'م2' && !state.teams["م2"].includes(nickname) && !state.teams["م1"].includes(nickname)) {
            state.teams["م2"].push(nickname);
            io.emit('stateUpdate', state);
            return;
        }
    }

    // ---- السحب العشوائي: جمع المشاركين بالكلمة المفتاحية ----
    if (state.mode === 'draw' && state.drawKeyword) {
        if (comment.includes(state.drawKeyword) && !state.drawParticipants.includes(nickname)) {
            state.drawParticipants.push(nickname);
            io.emit('drawParticipantsUpdate', state.drawParticipants);
        }
        return;
    }

    // ---- أسئلة وأجوبة / سباق كتابة: فحص الإجابات ----
    if (state.roundActive && state.currentQuestion) {
        // في وضع المجموعات، يجب أن يكون المستخدم منضماً لفريق
        const team = getPlayerTeam(nickname);
        if (state.teamMode && !team) return; // تجاهل من ليس ضمن أي فريق

        // منع الشخص من تسجيل إجابة صحيحة أكثر من مرة بنفس الجولة
        const alreadyAnswered = state.correctAnswers.some(a => a.name === nickname);
        if (alreadyAnswered) return;

        const userAnswer = normalizeAnswer(comment);
        const correct = normalizeAnswer(state.currentQuestion.correctAnswer);

        if (userAnswer === correct) {
            state.correctAnswers.push({ name: nickname, team: team || null, time: Date.now() });
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
    runServer();
});
