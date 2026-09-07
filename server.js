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
            { text: "من هو مصمم هذه الفعالية؟", correctAnswer: "جمال كوريني" },
            { text: "ما هي عاصمة السعودية؟", correctAnswer: "الرياض" },
            { text: "ما هي عاصمة مصر؟", correctAnswer: "القاهرة" },
            { text: "ما هي عاصمة الإمارات؟", correctAnswer: "أبوظبي" },
            { text: "ما هي عاصمة الأردن؟", correctAnswer: "عمان" },
            { text: "ما هي عاصمة لبنان؟", correctAnswer: "بيروت" },
            { text: "ما هي عاصمة العراق؟", correctAnswer: "بغداد" },
            { text: "ما هي عاصمة سوريا؟", correctAnswer: "دمشق" },
            { text: "ما هي عاصمة المغرب؟", correctAnswer: "الرباط" },
            { text: "ما هي عاصمة الجزائر؟", correctAnswer: "الجزائر" },
            { text: "ما هي عاصمة تونس؟", correctAnswer: "تونس" },
            { text: "ما هي عاصمة الكويت؟", correctAnswer: "الكويت" },
            { text: "ما هي عاصمة قطر؟", correctAnswer: "الدوحة" },
            { text: "ما هي عاصمة اليمن؟", correctAnswer: "صنعاء" },
            { text: "ما هي عاصمة فرنسا؟", correctAnswer: "باريس" },
            { text: "ما هي عاصمة إيطاليا؟", correctAnswer: "روما" },
            { text: "ما هي عاصمة اليابان؟", correctAnswer: "طوكيو" },
            { text: "ما هي عاصمة الصين؟", correctAnswer: "بكين" },
            { text: "ما هي عاصمة روسيا؟", correctAnswer: "موسكو" },
            { text: "ما هي عاصمة ألمانيا؟", correctAnswer: "برلين" },
            { text: "ما هي عاصمة إسبانيا؟", correctAnswer: "مدريد" },
            { text: "ما هي عاصمة بريطانيا؟", correctAnswer: "لندن" },
            { text: "ما هي عاصمة كندا؟", correctAnswer: "أوتاوا" },
            { text: "ما هي عاصمة البرازيل؟", correctAnswer: "برازيليا" },
            { text: "ما هي عاصمة أستراليا؟", correctAnswer: "كانبيرا" },
            { text: "ما هي عاصمة تركيا؟", correctAnswer: "أنقرة" },
            { text: "كم عدد قارات العالم؟", correctAnswer: "7" },
            { text: "ما هي أكبر قارة في العالم؟", correctAnswer: "آسيا" },
            { text: "ما هي أصغر قارة في العالم؟", correctAnswer: "أستراليا" },
            { text: "ما هو أطول نهر في العالم؟", correctAnswer: "نهر النيل" },
            { text: "ما هي أكبر صحراء في العالم؟", correctAnswer: "الصحراء الكبرى" },
            { text: "ما هو أعلى جبل في العالم؟", correctAnswer: "إفرست" },
            { text: "ما هو أكبر محيط في العالم؟", correctAnswer: "المحيط الهادئ" },
            { text: "ما هي أصغر دولة في العالم؟", correctAnswer: "الفاتيكان" },
            { text: "كم عدد أيام السنة الميلادية؟", correctAnswer: "365" },
            { text: "كم عدد أشهر السنة؟", correctAnswer: "12" },
            { text: "كم عدد أيام الأسبوع؟", correctAnswer: "7" },
            { text: "كم عدد ساعات اليوم؟", correctAnswer: "24" },
            { text: "ما هو أكبر كوكب في المجموعة الشمسية؟", correctAnswer: "المشتري" },
            { text: "ما هو أقرب كوكب إلى الشمس؟", correctAnswer: "عطارد" },
            { text: "ما اسم الكوكب الذي نعيش عليه؟", correctAnswer: "الأرض" },
            { text: "ما هو القمر الطبيعي للأرض؟", correctAnswer: "القمر" },
            { text: "كم عدد كواكب المجموعة الشمسية؟", correctAnswer: "8" },
            { text: "ما هو الغاز الذي يتنفسه الإنسان؟", correctAnswer: "الأكسجين" },
            { text: "ما هو الغاز الذي تطلقه النباتات نهاراً؟", correctAnswer: "الأكسجين" },
            { text: "كم عدد عظام جسم الإنسان البالغ؟", correctAnswer: "206" },
            { text: "ما هو أكبر عضو في جسم الإنسان؟", correctAnswer: "الجلد" },
            { text: "كم عدد حواس الإنسان؟", correctAnswer: "5" },
            { text: "ما هو العضو المسؤول عن ضخ الدم؟", correctAnswer: "القلب" },
            { text: "ما هي وحدة قياس درجة الحرارة الشائعة؟", correctAnswer: "الدرجة المئوية" },
            { text: "ما هي وحدة قياس الوزن الأساسية؟", correctAnswer: "الكيلوغرام" },
            { text: "ما هي وحدة قياس الطول الأساسية؟", correctAnswer: "المتر" },
            { text: "من مخترع المصباح الكهربائي؟", correctAnswer: "توماس إديسون" },
            { text: "من مخترع الهاتف؟", correctAnswer: "ألكسندر غراهام بيل" },
            { text: "من هو مكتشف الجاذبية؟", correctAnswer: "إسحاق نيوتن" },
            { text: "من هو مكتشف أمريكا؟", correctAnswer: "كريستوفر كولومبوس" },
            { text: "ما هي عملة السعودية؟", correctAnswer: "الريال" },
            { text: "ما هي عملة مصر؟", correctAnswer: "الجنيه" },
            { text: "ما هي عملة أمريكا؟", correctAnswer: "الدولار" },
            { text: "ما هي عملة بريطانيا؟", correctAnswer: "الجنيه الإسترليني" },
            { text: "ما هي عملة اليابان؟", correctAnswer: "الين" },
            { text: "كم عدد لاعبي فريق كرة القدم في الملعب؟", correctAnswer: "11" },
            { text: "كم عدد أشواط مباراة كرة القدم؟", correctAnswer: "شوطان" },
            { text: "كل كم سنة تقام كأس العالم لكرة القدم؟", correctAnswer: "4" },
            { text: "ما هو أشهر برج في فرنسا؟", correctAnswer: "برج إيفل" },
            { text: "ما هو أشهر برج في دبي؟", correctAnswer: "برج خليفة" },
            { text: "أين يقع سور الصين العظيم؟", correctAnswer: "الصين" },
            { text: "أين توجد أهرامات الجيزة؟", correctAnswer: "مصر" },
            { text: "ما هي أكبر جزيرة في العالم؟", correctAnswer: "جرينلاند" },
            { text: "ما هو أسرع حيوان بري في العالم؟", correctAnswer: "الفهد" },
            { text: "ما هو أكبر حيوان في العالم؟", correctAnswer: "الحوت الأزرق" },
            { text: "ما هو ملك الغابة؟", correctAnswer: "الأسد" },
            { text: "ما هو الحيوان المعروف بسفينة الصحراء؟", correctAnswer: "الجمل" },
            { text: "كم عدد أرجل العنكبوت؟", correctAnswer: "8" },
            { text: "كم عدد أرجل النملة؟", correctAnswer: "6" },
            { text: "ما هو الحيوان الذي يغير لونه؟", correctAnswer: "الحرباء" },
            { text: "ما هي لغة معظم دول أمريكا اللاتينية؟", correctAnswer: "الإسبانية" },
            { text: "ما هي اللغة الرسمية في البرازيل؟", correctAnswer: "البرتغالية" },
            { text: "كم عدد حروف اللغة العربية؟", correctAnswer: "28" },
            { text: "كم عدد حروف اللغة الإنجليزية؟", correctAnswer: "26" },
            { text: "ما هو أشهر لون في علم السعودية؟", correctAnswer: "الأخضر" },
            { text: "كم عدد ألوان قوس قزح؟", correctAnswer: "7" },
            { text: "ما هو اللون الناتج عن مزج الأزرق والأصفر؟", correctAnswer: "الأخضر" },
            { text: "ما هو اللون الناتج عن مزج الأحمر والأزرق؟", correctAnswer: "البنفسجي" },
            { text: "ما هو الرمز الكيميائي للماء؟", correctAnswer: "H2O" },
            { text: "ما هو الرمز الكيميائي للذهب؟", correctAnswer: "Au" },
            { text: "كم عدد أسنان الإنسان البالغ؟", correctAnswer: "32" },
            { text: "ما هي أصغر وحدة في الكائن الحي؟", correctAnswer: "الخلية" },
            { text: "ما اسم الطبقة التي تحمي الأرض من الأشعة؟", correctAnswer: "طبقة الأوزون" },
            { text: "كم عدد النوتات الموسيقية الأساسية؟", correctAnswer: "7" },
            { text: "ما هي الرياضة التي تلعب بمضرب وكرة صغيرة بيضاء؟", correctAnswer: "تنس الطاولة" },
            { text: "كم عدد حلقات الألعاب الأولمبية؟", correctAnswer: "5" },
            { text: "كل كم سنة تقام الألعاب الأولمبية؟", correctAnswer: "4" },
            { text: "ما هو أشهر متحف في فرنسا؟", correctAnswer: "متحف اللوفر" },
            { text: "ما هي أطول سلسلة جبال في العالم؟", correctAnswer: "جبال الأنديز" },
            { text: "ما اسم أكبر بحيرة في العالم؟", correctAnswer: "بحر قزوين" },
            { text: "ما هو الكوكب المعروف بالكوكب الأحمر؟", correctAnswer: "المريخ" },
            { text: "ما اسم أول رائد فضاء وصل إلى القمر؟", correctAnswer: "نيل أرمسترونغ" },
            { text: "من مخترع الطباعة؟", correctAnswer: "يوهانس غوتنبرغ" },
            { text: "ما هي المدينة المعروفة بمدينة الضباب؟", correctAnswer: "لندن" },
            { text: "ما اسم أشهر ساعة في لندن؟", correctAnswer: "بيغ بن" }
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
            { text: "من هو الصحابي الجليل الذي لُقب بـ \"سيف الله المسلول\"؟", correctAnswer: "خالد بن الوليد" },
            { text: "كم عدد أركان الإسلام؟", correctAnswer: "5" },
            { text: "ما هو الركن الأول من أركان الإسلام؟", correctAnswer: "الشهادتان" },
            { text: "كم عدد الصلوات المفروضة في اليوم والليلة؟", correctAnswer: "5" },
            { text: "ما هو الكتاب المقدس عند المسلمين؟", correctAnswer: "القرآن الكريم" },
            { text: "من هو الملك الذي كان ينزل بالوحي على النبي؟", correctAnswer: "جبريل" },
            { text: "ما هي أول سورة نزلت من القرآن؟", correctAnswer: "العلق" },
            { text: "ما هي أقصر سورة في القرآن؟", correctAnswer: "الكوثر" },
            { text: "كم عدد أشهر السنة الهجرية؟", correctAnswer: "12" },
            { text: "ما اسم العيد الذي يأتي بعد رمضان؟", correctAnswer: "عيد الفطر" },
            { text: "ما اسم العيد الذي يرتبط بالحج؟", correctAnswer: "عيد الأضحى" },
            { text: "إلى أي مدينة يتوجه الحجاج لأداء الحج؟", correctAnswer: "مكة المكرمة" },
            { text: "ما اسم الركن الذي يطوف فيه المسلمون حول الكعبة؟", correctAnswer: "الطواف" },
            { text: "ما اسم المسجد الذي تقع فيه الكعبة؟", correctAnswer: "المسجد الحرام" },
            { text: "ما اسم المسجد الذي دفن فيه النبي محمد؟", correctAnswer: "المسجد النبوي" },
            { text: "في أي مدينة يقع المسجد النبوي؟", correctAnswer: "المدينة المنورة" },
            { text: "ما هي الزكاة؟", correctAnswer: "إخراج جزء من المال للفقراء" },
            { text: "ما هو الركن الرابع من أركان الإسلام؟", correctAnswer: "الصيام" },
            { text: "ما هو الركن الخامس من أركان الإسلام؟", correctAnswer: "الحج" },
            { text: "كم عدد أركان الإيمان؟", correctAnswer: "6" },
            { text: "من هو آخر الأنبياء والرسل؟", correctAnswer: "محمد" },
            { text: "ما اسم زوجة النبي الأولى؟", correctAnswer: "خديجة" },
            { text: "من هو الخليفة الراشدي الثاني؟", correctAnswer: "عمر بن الخطاب" },
            { text: "من هو الخليفة الراشدي الثالث؟", correctAnswer: "عثمان بن عفان" },
            { text: "من هو الخليفة الراشدي الرابع؟", correctAnswer: "علي بن أبي طالب" },
            { text: "ما اسم أول من آمن بالنبي من الرجال؟", correctAnswer: "أبو بكر الصديق" },
            { text: "ما اسم أول من آمن بالنبي من النساء؟", correctAnswer: "خديجة" },
            { text: "ما هي القبلة التي يتجه إليها المسلمون في الصلاة؟", correctAnswer: "الكعبة" },
            { text: "ما اسم الآذان الذي يُنادى به للصلاة؟", correctAnswer: "الأذان" },
            { text: "كم عدد ركعات صلاة الفجر؟", correctAnswer: "ركعتان" },
            { text: "كم عدد ركعات صلاة الظهر؟", correctAnswer: "4" },
            { text: "كم عدد ركعات صلاة المغرب؟", correctAnswer: "3" },
            { text: "ما هو اليوم الذي تقام فيه صلاة الجمعة؟", correctAnswer: "الجمعة" },
            { text: "ما اسم الكتاب الذي أنزل على سيدنا موسى؟", correctAnswer: "التوراة" },
            { text: "ما اسم الكتاب الذي أنزل على سيدنا عيسى؟", correctAnswer: "الإنجيل" },
            { text: "ما اسم الكتاب الذي أنزل على سيدنا داود؟", correctAnswer: "الزبور" },
            { text: "من هو النبي الذي بنى السفينة؟", correctAnswer: "نوح" },
            { text: "من هو النبي المعروف بالصبر؟", correctAnswer: "أيوب" },
            { text: "من هو النبي الذي أُلقي في النار فلم تحرقه؟", correctAnswer: "إبراهيم" },
            { text: "من هو أبو الأنبياء؟", correctAnswer: "إبراهيم" },
            { text: "من هو النبي الذي كلمه الله مباشرة؟", correctAnswer: "موسى" },
            { text: "ما اسم جبل نزل فيه أول الوحي على النبي؟", correctAnswer: "جبل النور" },
            { text: "ما اسم الغار الذي كان يتعبد فيه النبي قبل البعثة؟", correctAnswer: "غار حراء" }
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
