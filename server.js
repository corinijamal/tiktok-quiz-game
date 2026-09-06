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
    ],
    "إسلاميات": [
        { text: "ما هي السورة التي تُسمى بـ \"قلب القرآن\"؟", type: "direct", correctAnswer: "يس" },
        { text: "من هو أول الخلفاء الراشدين؟", type: "direct", correctAnswer: "أبو بكر الصديق" },
        { text: "كم عدد سور القرآن الكريم؟", type: "direct", correctAnswer: "114" },
        { text: "ما هي الغزوة التي سُميت بـ \"يوم الفرقان\"؟", type: "direct", correctAnswer: "غزوة بدر" },
        { text: "من هو النبي الذي ابتلعه الحوت؟", type: "direct", correctAnswer: "يونس" },
        { text: "في أي شهر نزل القرآن الكريم؟", type: "direct", correctAnswer: "رمضان" },
        { text: "ما هي أطول سورة في القرآن الكريم؟", type: "direct", correctAnswer: "البقرة" },
        { text: "من هي المرأة التي لُقبت بـ \"ذات النطاقين\"؟", type: "direct", correctAnswer: "أسماء بنت أبي بكر" },
        { text: "ما هو أول مسجد بُني في الإسلام؟", type: "direct", correctAnswer: "مسجد قباء" },
        { text: "من هو الصحابي الجليل الذي لُقب بـ \"سيف الله المسلول\"؟", type: "direct", correctAnswer: "خالد بن الوليد" }
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
        .replace(/[.,،؟!"']/g, '')       // إزالة علامات الترقيم
        .replace(/\s+/g, ' ')
        .trim();
}

// عبارات وكلمات لاحقة/زائدة شائعة تُحذف من الإجابة الصحيحة المرجعية
// حتى لا يُشترط على المشاهد كتابتها ليُحتسب جوابه صحيحاً
const TRAILING_PHRASES = [
    'رضي الله عنه وعنها', 'رضي الله عنهما', 'رضي الله عنهم',
    'رضي الله عنه', 'رضي الله عنها',
    'عليه الصلاة والسلام', 'عليه السلام', 'صلى الله عليه وسلم'
];
const TRAILING_WORDS = ['سورة', 'سوره', 'غزوة', 'غزوه'];

function extractCoreAnswer(rawAnswer) {
    let core = normalizeAnswer(rawAnswer);

    // إزالة عبارات الترضي/الترحّم أينما وردت
    for (const phrase of TRAILING_PHRASES) {
        core = core.replace(normalizeAnswer(phrase), '').trim();
    }

    // إزالة كلمة وصفية زائدة إذا جاءت في أول أو آخر الإجابة (مثل "114 سورة" أو "سورة البقرة")
    const words = core.split(' ').filter(Boolean);
    const filtered = words.filter(w => !TRAILING_WORDS.includes(w));
    core = filtered.length > 0 ? filtered.join(' ') : core;

    return core.trim();
}

// تحقق إن كانت إجابة المشاهد تطابق "جوهر" الإجابة الصحيحة
// تقبل: التطابق التام، أو احتواء المشاهد لكل كلمات الجوهر (بأي ترتيب متتالٍ)،
// أو أن يكون الجوهر يبدأ بنفس كلمات إجابة المشاهد (مثال: "ابو بكر" ضمن "ابو بكر الصديق")
function isAnswerCorrect(userComment, correctRawAnswer) {
    const userAnswer = normalizeAnswer(userComment);
    if (!userAnswer) return false;

    const core = extractCoreAnswer(correctRawAnswer);
    const fullCorrect = normalizeAnswer(correctRawAnswer);

    if (userAnswer === fullCorrect || userAnswer === core) return true;

    // المشاهد كتب الجوهر كاملاً ضمن جملة أطول (مثال: "الجواب ابو بكر الصديق")
    if (core.length >= 2 && userAnswer.includes(core)) return true;

    // المشاهد كتب جزءاً كافياً من الجوهر (مثال: "ابو بكر" بدل "ابو بكر الصديق")
    // يُشترط أن يطابق بداية الجوهر بكلمات كاملة متتالية، وألا يكون قصيراً جداً (حرف أو حرفين)
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

        if (isAnswerCorrect(comment, state.currentQuestion.correctAnswer)) {
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
