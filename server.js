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
let leaderboardCollection = null;
let dbReady = false;

async function connectDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("tiktok_quiz");
        customSectionsCollection = db.collection("customSections");
        leaderboardCollection = db.collection("leaderboard");
        console.log('✅ متصل بقاعدة بيانات MongoDB بنجاح');
        await loadCustomSectionsFromDB();
        await loadLeaderboardFromDB();
        dbReady = true;
        broadcastSectionsLists();
        broadcastHistoricalLeaderboard();
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

// ==================== السجل التاريخي الدائم لقائمة المتصدرين ====================
// شكل كل مستند: { _id: اسم اللاعب, correctAnswers: عدد, gold: عدد, silver: عدد, bronze: عدد }
let historicalLeaderboard = {}; // نسخة في الذاكرة للقراءة السريعة، مرآة لقاعدة البيانات

async function loadLeaderboardFromDB() {
    if (!leaderboardCollection) return;
    const docs = await leaderboardCollection.find({}).toArray();
    historicalLeaderboard = {};
    docs.forEach(doc => {
        historicalLeaderboard[doc._id] = {
            correctAnswers: doc.correctAnswers || 0,
            gold: doc.gold || 0,
            silver: doc.silver || 0,
            bronze: doc.bronze || 0
        };
    });
    console.log(`🏆 تم تحميل سجل ${docs.length} لاعب من قائمة المتصدرين التاريخية`);
}

async function addHistoricalCorrectAnswer(name) {
    if (!historicalLeaderboard[name]) {
        historicalLeaderboard[name] = { correctAnswers: 0, gold: 0, silver: 0, bronze: 0 };
    }
    historicalLeaderboard[name].correctAnswers += 1;
    if (leaderboardCollection) {
        try {
            await leaderboardCollection.updateOne(
                { _id: name },
                { $inc: { correctAnswers: 1 }, $setOnInsert: { gold: 0, silver: 0, bronze: 0 } },
                { upsert: true }
            );
        } catch (err) {
            console.error('❌ خطأ أثناء حفظ إجابة صحيحة بالسجل التاريخي:', err.toString());
        }
    }
}

async function addHistoricalMedal(name, medalType) {
    if (!historicalLeaderboard[name]) {
        historicalLeaderboard[name] = { correctAnswers: 0, gold: 0, silver: 0, bronze: 0 };
    }
    historicalLeaderboard[name][medalType] += 1;
    if (leaderboardCollection) {
        try {
            const incField = {};
            incField[medalType] = 1;
            await leaderboardCollection.updateOne(
                { _id: name },
                { $inc: incField, $setOnInsert: { correctAnswers: 0 } },
                { upsert: true }
            );
        } catch (err) {
            console.error('❌ خطأ أثناء حفظ ميدالية بالسجل التاريخي:', err.toString());
        }
    }
}

async function clearHistoricalLeaderboard() {
    historicalLeaderboard = {};
    if (leaderboardCollection) {
        try {
            await leaderboardCollection.deleteMany({});
        } catch (err) {
            console.error('❌ خطأ أثناء مسح السجل التاريخي:', err.toString());
        }
    }
    broadcastHistoricalLeaderboard();
}

function broadcastHistoricalLeaderboard() {
    const list = Object.entries(historicalLeaderboard)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => (b.gold - a.gold) || (b.silver - a.silver) || (b.bronze - a.bronze) || (b.correctAnswers - a.correctAnswers));
    io.emit('historicalLeaderboardUpdate', list);
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
    },
    "شعر": {
        type: "direct",
        questions: [
            { text: "أكمل البيت الشعري:\nيا منزل الآيات والفرقان\nبيني وبينك حرمة ...\nمساعدة | أول حرف: ا | آخر حرف: ن | عدد الحروف: 6", correctAnswer: "القرآن" },
            { text: "أكمل البيت الشعري:\nاشرح به صدري لمعرفة ...\nواعصم به قلبي من الشيطان\nمساعدة | أول حرف: ا | آخر حرف: ى | عدد الحروف: 5", correctAnswer: "الهدى" },
            { text: "أكمل البيت الشعري:\nيسر به أمري وأقض ...\nوأجر به جسدي من النيران\nمساعدة | أول حرف: م | آخر حرف: ي | عدد الحروف: 5", correctAnswer: "مآربي" },
            { text: "أكمل البيت الشعري:\nواحطط به ... وأخلص نيتي\nواشدد به أزري وأصلح شاني\nمساعدة | أول حرف: و | آخر حرف: ي | عدد الحروف: 4", correctAnswer: "وزري" },
            { text: "أكمل البيت الشعري:\nواكشف به ضري وحقق توبتي\nواربح به ... بلا خسران\nمساعدة | أول حرف: ب | آخر حرف: ي | عدد الحروف: 4", correctAnswer: "بيعي" },
            { text: "أكمل البيت الشعري:\nطهر به قلبي وصف ...\nأجمل به ذكري واعل مكاني\nمساعدة | أول حرف: س | آخر حرف: ي | عدد الحروف: 6", correctAnswer: "سريرتي" },
            { text: "أكمل البيت الشعري:\nواقطع به طمعي وشرف ...\nكثر به ورعي واحي جناني\nمساعدة | أول حرف: ه | آخر حرف: ي | عدد الحروف: 4", correctAnswer: "همتي" },
            { text: "أكمل البيت الشعري:\nأسهر به ليلي وأظم ...\nأسبل بفيض دموعها أجفاني\nمساعدة | أول حرف: ج | آخر حرف: ي | عدد الحروف: 6", correctAnswer: "جوارحي" },
            { text: "أكمل البيت الشعري:\nأمزجه يا رب ... مع دمي\nواغسل به قلبي من الأضغان\nمساعدة | أول حرف: ب | آخر حرف: ي | عدد الحروف: 5", correctAnswer: "بلحمي" },
            { text: "أكمل البيت الشعري:\nولأكسون عيوب نفسي بالتقى\nولأقبضن عن الفجور ...\nمساعدة | أول حرف: ع | آخر حرف: ي | عدد الحروف: 5", correctAnswer: "عناني" },
            { text: "أكمل البيت الشعري:\nولأمنعن النفس عن شهواتها\nولأجعلن ... من أعواني\nمساعدة | أول حرف: ا | آخر حرف: د | عدد الحروف: 4", correctAnswer: "الزهد" },
            { text: "أكمل البيت الشعري:\nولأتلون حروف وحيك في الدجى\nولأحرقن بنوره ...\nمساعدة | أول حرف: ش | آخر حرف: ي | عدد الحروف: 7", correctAnswer: "شيطاني" },
            { text: "أكمل البيت الشعري:\nنادى بصوت حين كلم عبده\nموسى فأسمعه بلا ...\nمساعدة | أول حرف: ك | آخر حرف: م | عدد الحروف: 5", correctAnswer: "كتمان" },
            { text: "أكمل البيت الشعري:\nلا تجزعن إذا دهتك مصيبة\nإن الصبور ثوابه ...\nمساعدة | أول حرف: ض | آخر حرف: ف | عدد الحروف: 6", correctAnswer: "ضعفان" },
            { text: "أكمل البيت الشعري:\nفإذا ابتليت بنكبة فاصبر لها\nالله حسبي وحده ...\nمساعدة | أول حرف: ك | آخر حرف: ي | عدد الحروف: 5", correctAnswer: "كفاني" },
            { text: "أكمل البيت الشعري:\nإذا ابتليت بعسرة فاصبر لها\nفالعسر فرد بعده ...\nمساعدة | أول حرف: ي | آخر حرف: ن | عدد الحروف: 5", correctAnswer: "يسران" },
            { text: "أكمل البيت الشعري:\nلا تشغلن بعيب غيرك غافلا\nعن عيب نفسك إنه ...\nمساعدة | أول حرف: ع | آخر حرف: ن | عدد الحروف: 5", correctAnswer: "عيبان" },
            { text: "أكمل البيت الشعري:\nكن حلس بيتك إن سمعت بفتنة\nوتوق كل منافق ...\nمساعدة | أول حرف: ف | آخر حرف: ن | عدد الحروف: 4", correctAnswer: "فتان" },
            { text: "أكمل بيت المتنبي:\nعلى قدر أهل العزم تأتي العزائم\nوتأتي على قدر ... المكارم\nمساعدة | أول حرف: ا | آخر حرف: م | عدد الحروف: 5", correctAnswer: "الكرام" },
            { text: "أكمل بيت المتنبي:\nوتعظم في عين الصغير صغارها\nوتصغر في عين ... الكبير الكبار\nمساعدة | أول حرف: ا | آخر حرف: م | عدد الحروف: 6", correctAnswer: "العظيم" },
            { text: "أكمل بيت المتنبي:\nإذا غامرت في شرف مروم\nفلا تقنع بما دون ...\nمساعدة | أول حرف: ا | آخر حرف: م | عدد الحروف: 6", correctAnswer: "النجوم" },
            { text: "أكمل بيت المتنبي:\nومن يك ذا فم مر مريض\nيجد مرا به ... الزلال\nمساعدة | أول حرف: ا | آخر حرف: ء | عدد الحروف: 3", correctAnswer: "الما" },
            { text: "أكمل بيت أبي الطيب المتنبي:\nالخيل والليل والبيداء تعرفني\nوالسيف والرمح والقرطاس ...\nمساعدة | أول حرف: و | آخر حرف: م | عدد الحروف: 7", correctAnswer: "والقلم" },
            { text: "أكمل بيت المتنبي:\nإذا رأيت نيوب الليث بارزة\nفلا تظنن أن الليث ...\nمساعدة | أول حرف: ي | آخر حرف: م | عدد الحروف: 6", correctAnswer: "يبتسم" },
            { text: "أكمل بيت أبي تمام:\nالسيف أصدق أنباء من ...\nفي حده الحد بين الجد واللعب\nمساعدة | أول حرف: ا | آخر حرف: ب | عدد الحروف: 5", correctAnswer: "الكتب" },
            { text: "أكمل بيت أحمد شوقي:\nقم للمعلم وفه التبجيلا\nكاد المعلم أن يكون ...\nمساعدة | أول حرف: ر | آخر حرف: لا | عدد الحروف: 6", correctAnswer: "رسولا" },
            { text: "أكمل بيت أحمد شوقي:\nوطني لو شغلت بالخلد عنه\nنازعتني إليه في الخلد ...\nمساعدة | أول حرف: ن | آخر حرف: ي | عدد الحروف: 5", correctAnswer: "نفسي" },
            { text: "أكمل بيت المتنبي المشهور:\nأنام ملء جفوني عن شواردها\nويسهر الخلق ...\nمساعدة | أول حرف: ج | آخر حرف: ي | عدد الحروف: 6", correctAnswer: "جراها" },
            { text: "أكمل بيت الإمام الشافعي:\nدعِ الأيامَ تفعلُ ما تشاءُ\nوطِبْ نفساً إذا حكم ...\nمساعدة | أول حرف: ا | آخر حرف: ء | عدد الحروف: 6", correctAnswer: "القضاء" },
            { text: "أكمل بيت الإمام الشافعي:\nولا تجزع لحادثة الليالي\nفما لحوادث الدنيا ...\nمساعدة | أول حرف: ب | آخر حرف: ء | عدد الحروف: 5", correctAnswer: "بقاء" },
            { text: "أكمل بيت الإمام الشافعي:\nإذا كان قلبي على أنسه\nليأنس بالذكر ذاك ...\nمساعدة | أول حرف: ا | آخر حرف: ن | عدد الحروف: 6", correctAnswer: "الإحسان" },
            { text: "أكمل بيت لأبي العتاهية:\nإذا المرء لم يدنس من اللؤم عرضه\nفكل رداء ...\nمساعدة | أول حرف: ي | آخر حرف: ه | عدد الحروف: 6", correctAnswer: "يرتديه" },
            { text: "أكمل بيت عنترة بن شداد:\nولقد ذكرتك والرماح نواهل\nمني وبيض الهند ...\nمساعدة | أول حرف: ت | آخر حرف: ي | عدد الحروف: 5", correctAnswer: "تقطر" }
        ]
    }
};

// ==================== الأقسام الخاصة (يديرها الأدمن، تُحفظ في الذاكرة + قاعدة البيانات) ====================
let customSections = {};
let customSectionIdCounter = 1;
let customQuestionIdCounter = 1;

// ==================== حالة النظام العامة ====================
let state = {
    // نظام المسابقة: 'manual' (يدوي) أو 'auto' (تلقائي)
    competitionMode: 'auto',

    // نظام التوقيت: 'speed' (سريع) أو 'time' (وقت)
    timingMode: 'time',

    // المجموعات
    teamMode: false,
    registrationOpen: false,
    teams: { م1: [], م2: [] },
    manualTeamPoints: { م1: 0, م2: 0 }, // نقاط إضافية يدوية من الأدمن (➕/➖) تُضاف لنتيجة المسابقة الحالية

    // السحب العشوائي
    drawMode: false,
    drawKeyword: null,
    drawParticipants: [],

    // إعداد المسابقة الحالية
    competitionActive: false,
    competitionPaused: false,
    competitionSelectedSections: [], // [{ source: 'bank'|'custom', name: '...' }]
    competitionDuration: null,
    competitionTotalQuestions: null,
    competitionAskedCount: 0,
    competitionQueue: [], // [{ source, sectionName, questionIndex }] مخلوطة بلا تكرار حتى انتهاء العدد المطلوب

    // السؤال الحالي
    currentQuestion: null,       // { text, choices? }
    currentCorrectAnswer: null,  // { text } أو { choices, correctIndex }
    roundActive: false,
    roundStartTime: null,
    roundEndsAt: null,           // الوقت المتوقع لانتهاء الجولة (يُعاد حسابه عند تفعيل السرعة)
    waitingForNext: false,       // بعد انتهاء وقت السؤال: تُعرض شاشة الإجابة الصحيحة
    showingAnswerReveal: false,  // true أثناء عرض "الإجابة الصحيحة + أصحاب الإجابات" (5 ثوانٍ بالتلقائي أو حتى ضغط الأدمن باليدوي)
    speedTriggered: false,       // في النظام السريع: هل تم بالفعل تقليص الوقت بعد أول إجابة صحيحة لهذا السؤال

    // نتائج المسابقة الحالية فقط (تُصفَّر مع كل مسابقة جديدة)
    correctAnswersThisQuestion: [], // [{ name, team, timeSeconds }] بترتيب الوصول لهذا السؤال فقط، بالثواني من بداية السؤال
    competitionResults: {},         // { name: { count, team, firstAnswerTime, totalAnswerTimeMs } } لكل المسابقة الحالية
    competitionFinished: false,
    competitionFinalRanking: []     // تُحسب عند انتهاء المسابقة: [{ name, count, team, medal }]
};

let questionTimer = null;      // مؤقت انتهاء وقت السؤال أو مؤقت شاشة الإجابة الصحيحة (5 ثوانٍ)

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

    // الصيغة المطلوبة: "خ" متبوعة برقم الخيار (خ1، خ2، خ3، خ4)
    // خ تتحول لـ "ح" أحياناً عبر الكيبورد أو تبقى كما هي؛ نقبل "خ" فقط كما طُلب، مع تجاهل مسافة محتملة بينها وبين الرقم
    const khMatch = userAnswer.match(/^خ\s*([1-4])$/);
    if (khMatch) {
        return (parseInt(khMatch[1], 10) - 1) === correctIndex;
    }

    // قبول الرقم المجرد أيضاً كصيغة احتياطية
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

// ترتيب المتسابقين الحاليين أثناء المسابقة (تُعرض تحت السؤال أثناء اللعب)
function getCurrentCompetitionRanking() {
    if (state.teamMode) {
        const teamCounts = { م1: 0, م2: 0 };
        Object.values(state.competitionResults).forEach(r => {
            if (r.team) teamCounts[r.team] += r.count;
        });
        teamCounts['م1'] += state.manualTeamPoints['م1'] || 0;
        teamCounts['م2'] += state.manualTeamPoints['م2'] || 0;
        return { teamMode: true, teamCounts };
    } else {
        const sorted = Object.entries(state.competitionResults)
            .map(([name, r]) => ({ name, count: r.count, firstAnswerTime: r.firstAnswerTime }))
            .sort((a, b) => b.count - a.count || a.firstAnswerTime - b.firstAnswerTime);
        return { teamMode: false, ranking: sorted };
    }
}

function broadcastCurrentRanking() {
    io.emit('currentRankingUpdate', getCurrentCompetitionRanking());
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
// يبني قائمة أسئلة مخلوطة من عدة أقسام مجتمعة، بلا تكرار، بحد أقصى العدد المطلوب
function buildQuestionQueue(selectedSections, totalQuestions) {
    let pool = [];
    selectedSections.forEach(sec => {
        const questions = getSectionQuestions(sec.source, sec.name);
        const type = getSectionType(sec.source, sec.name);
        questions.forEach((q, idx) => {
            pool.push({ source: sec.source, sectionName: sec.name, questionIndex: idx, type });
        });
    });
    pool = shuffleArray(pool);
    return pool.slice(0, Math.min(totalQuestions, pool.length));
}

function startCompetition(selectedSections, duration, totalQuestions, timingMode) {
    if (!selectedSections || selectedSections.length === 0) return false;

    const queue = buildQuestionQueue(selectedSections, totalQuestions);
    if (queue.length === 0) return false;

    state.competitionActive = true;
    state.competitionPaused = false;
    state.competitionSelectedSections = selectedSections;
    state.competitionDuration = duration;
    state.timingMode = timingMode === 'speed' ? 'speed' : 'time';
    state.competitionTotalQuestions = queue.length;
    state.competitionAskedCount = 0;
    state.competitionQueue = queue;
    state.competitionResults = {};
    state.manualTeamPoints = { م1: 0, م2: 0 };
    state.competitionFinished = false;
    state.competitionFinalRanking = [];
    state.currentQuestion = null;
    state.roundActive = false;
    state.waitingForNext = false;
    state.showingAnswerReveal = false;

    broadcastState();
    askNextQuestion();
    return true;
}

function askNextQuestion() {
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }

    if (state.competitionQueue.length === 0) {
        finishCompetition();
        return;
    }

    const item = state.competitionQueue.shift();
    const questions = getSectionQuestions(item.source, item.sectionName);
    const q = questions[item.questionIndex];

    state.competitionAskedCount += 1;
    state.correctAnswersThisQuestion = [];
    state.roundStartTime = Date.now();
    state.roundActive = true;
    state.waitingForNext = false;
    state.showingAnswerReveal = false;
    state.speedTriggered = false;

    if (item.type === 'choices') {
        state.currentQuestion = { text: q.text, choices: q.choices, sectionName: item.sectionName };
        state.currentCorrectAnswer = { choices: q.choices, correctIndex: q.correctIndex };
    } else {
        state.currentQuestion = { text: q.text, sectionName: item.sectionName };
        state.currentCorrectAnswer = { text: q.correctAnswer };
    }

    broadcastState();
    broadcastCurrentRanking();

    questionTimer = setTimeout(() => {
        revealAnswer();
    }, state.competitionDuration * 1000);
}

// تُستدعى عند انتهاء وقت السؤال الطبيعي، أو عند انتهاء مهلة الـ5 ثوانٍ بعد أول إجابة صحيحة في النظام السريع
function revealAnswer() {
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }

    state.roundActive = false;
    state.waitingForNext = true;
    state.showingAnswerReveal = true;
    broadcastState();

    if (state.competitionMode === 'auto') {
        questionTimer = setTimeout(() => {
            askNextQuestion();
        }, 5000);
    }
    // في الوضع اليدوي: تبقى شاشة الإجابة ظاهرة حتى ضغط الأدمن على "السؤال التالي"
}

function finishCompetition() {
    state.competitionActive = false;
    state.competitionFinished = true;
    state.roundActive = false;
    state.waitingForNext = false;
    state.showingAnswerReveal = false;
    state.currentQuestion = null;
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }

    // بناء الترتيب النهائي: عدد الإجابات الصحيحة تنازلياً، وعند التعادل الأسرع (متوسط سرعة الإجابة) يتقدم
    const ranking = Object.entries(state.competitionResults)
        .map(([name, r]) => ({
            name,
            count: r.count,
            team: r.team || null,
            avgSpeed: r.totalAnswerTimeMs / r.count // زمن أقل = أسرع = أفضل
        }))
        .sort((a, b) => b.count - a.count || a.avgSpeed - b.avgSpeed);

    // توزيع 3 ميداليات فقط للمراكز الثلاثة الأولى (فردي فقط؛ في وضع المجموعات لا ميداليات فردية)
    if (!state.teamMode) {
        const medals = ['gold', 'silver', 'bronze'];
        ranking.slice(0, 3).forEach((player, idx) => {
            player.medal = medals[idx];
            addHistoricalMedal(player.name, medals[idx]);
        });
    }

    state.competitionFinalRanking = ranking;
    broadcastState();
}

function nextQuestionManually() {
    if (!state.competitionActive || !state.waitingForNext) return;
    askNextQuestion();
}

function stopCompetitionManually() {
    state.competitionActive = false;
    state.competitionPaused = false;
    state.competitionFinished = false;
    state.roundActive = false;
    state.waitingForNext = false;
    state.showingAnswerReveal = false;
    state.currentQuestion = null;
    state.competitionSelectedSections = [];
    state.competitionQueue = [];
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
    broadcastState();
}

// إيقاف مؤقت: يجمّد المؤقت الحالي بحفظ الوقت المتبقي، بلا إنهاء المسابقة
let pausedRemainingMs = null;
function pauseCompetition() {
    if (!state.competitionActive || state.competitionPaused) return;
    if (state.roundActive && questionTimer) {
        const elapsed = Date.now() - state.roundStartTime;
        pausedRemainingMs = Math.max(0, state.competitionDuration * 1000 - elapsed);
        clearTimeout(questionTimer);
        questionTimer = null;
    }
    state.competitionPaused = true;
    broadcastState();
}

function resumeCompetition() {
    if (!state.competitionActive || !state.competitionPaused) return;
    state.competitionPaused = false;

    if (state.roundActive && pausedRemainingMs !== null) {
        // إعادة ضبط وقت البداية بحيث يبقى العداد المعروض متوافقاً مع الوقت المتبقي الفعلي
        state.roundStartTime = Date.now() - (state.competitionDuration * 1000 - pausedRemainingMs);
        questionTimer = setTimeout(() => {
            revealAnswer();
        }, pausedRemainingMs);
        pausedRemainingMs = null;
    }
    broadcastState();
}

function adjustManualTeamPoints(team, delta) {
    if (team !== 'م1' && team !== 'م2') return;
    state.manualTeamPoints[team] = Math.max(0, (state.manualTeamPoints[team] || 0) + delta);
    broadcastState();
    broadcastCurrentRanking();
}

// ==================== منطق الاتصال بلوحة التحكم (Socket.io) ====================
io.on('connection', (socket) => {
    console.log('📶 لوحة تحكم جديدة متصلة');
    socket.emit('stateUpdate', state);
    broadcastSectionsLists();
    broadcastHistoricalLeaderboard();
    if (state.competitionActive) broadcastCurrentRanking();

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

    // ---- إعدادات عامة ----
    socket.on('setCompetitionMode', (mode) => {
        state.competitionMode = mode === 'manual' ? 'manual' : 'auto';
        broadcastState();
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

    // ---- المسابقة ----
    socket.on('startCompetition', (payload) => {
        // payload: { sections: [{source, name}], duration, totalQuestions, timingMode: 'speed'|'time' }
        startCompetition(payload.sections, payload.duration, payload.totalQuestions, payload.timingMode);
    });

    socket.on('nextQuestionManually', () => {
        nextQuestionManually();
    });

    socket.on('stopCompetition', () => {
        stopCompetitionManually();
    });

    socket.on('pauseCompetition', () => {
        pauseCompetition();
    });

    socket.on('resumeCompetition', () => {
        resumeCompetition();
    });

    socket.on('adjustManualTeamPoints', (payload) => {
        // payload: { team: 'م1'|'م2', delta: 1 أو -1 }
        adjustManualTeamPoints(payload.team, payload.delta);
    });

    socket.on('dismissFinalResults', () => {
        state.competitionFinished = false;
        state.competitionResults = {};
        state.competitionFinalRanking = [];
        broadcastState();
    });

    // ---- السحب العشوائي ----
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
        io.emit('drawWinnerPicked', winner);
    });

    // ---- قائمة المتصدرين التاريخية ----
    socket.on('clearHistoricalLeaderboard', () => {
        clearHistoricalLeaderboard();
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

    if (state.roundActive && state.currentQuestion && state.currentCorrectAnswer && !state.competitionPaused) {
        const team = getPlayerTeam(nickname);
        if (state.teamMode && !team) return;

        const alreadyAnswered = state.correctAnswersThisQuestion.some(a => a.name === nickname);
        if (alreadyAnswered) return;

        // نوع السؤال الحالي محفوظ ضمن currentCorrectAnswer (choices تحتوي حقل choices، direct تحتوي text فقط)
        const isChoicesQuestion = !!state.currentCorrectAnswer.choices;
        let correct = false;
        if (isChoicesQuestion) {
            correct = isChoiceCorrect(comment, state.currentCorrectAnswer.choices, state.currentCorrectAnswer.correctIndex);
        } else {
            correct = isAnswerCorrect(comment, state.currentCorrectAnswer.text);
        }

        if (correct) {
            const answerTimeMs = Date.now() - state.roundStartTime;
            state.correctAnswersThisQuestion.push({ name: nickname, team: team || null, time: answerTimeMs });

            if (!state.competitionResults[nickname]) {
                state.competitionResults[nickname] = { count: 0, team: team || null, totalAnswerTimeMs: 0, firstAnswerTime: answerTimeMs };
            }
            state.competitionResults[nickname].count += 1;
            state.competitionResults[nickname].totalAnswerTimeMs += answerTimeMs;

            addHistoricalCorrectAnswer(nickname);

            io.emit('newCorrectAnswer', { name: nickname, team: team || null, order: state.correctAnswersThisQuestion.length });
            broadcastCurrentRanking();

            // النظام السريع: أول إجابة صحيحة تقلّص الوقت المتبقي إلى 5 ثوانٍ (فقط إذا كان المتبقي أكثر من 5)
            if (state.timingMode === 'speed' && !state.speedTriggered) {
                state.speedTriggered = true;
                const elapsedMs = Date.now() - state.roundStartTime;
                const totalMs = state.competitionDuration * 1000;
                const remainingMs = totalMs - elapsedMs;

                if (remainingMs > 5000) {
                    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
                    questionTimer = setTimeout(() => {
                        revealAnswer();
                    }, 5000);
                }
            }
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
