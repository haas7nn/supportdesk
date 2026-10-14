
// english and arabic for the portal and english is written in the html itself

(function () {
  const AR = {
    banner: "مشروع طالب فقط. هذا ليس نظاماً رسمياً لبنك البحرين الوطني وليس مرتبطاً به.",
    nav_email: "البريد", nav_devices: "الأجهزة", nav_printing: "الطباعة", nav_network: "الشبكة", nav_accounts: "الحسابات",
    login: "دخول فريق تقنية المعلومات",
    hero_big: "هل هناك شيء لا يعمل؟",
    hero_small: "أخبر المساعد أولاً. لمعظم المشاكل حل سريع.",
    start: "ابدأ محادثة",
    tile_slow: "الجهاز بطيء أو متجمد؟ جرّب هذا أولاً", tile_slow_link: "عرض الخطوات",
    tile_outlook: "أوتلوك لا يتحدث؟ غالباً بسبب وضع عدم الاتصال", tile_outlook_link: "إصلاح أوتلوك",
    tile_print: "الطابعة عالقة؟ امسح قائمة الطباعة في دقيقة", tile_print_link: "إصلاح الطباعة",
    col_email: "البريد الإلكتروني", col_devices: "الأجهزة", col_printing: "الطباعة", col_network: "الشبكة", col_accounts: "الحسابات", col_contact: "تواصل مع تقنية المعلومات",
    l_outlook: "أوتلوك لا يتحدث", l_notreceiving: "لا يصلني البريد", l_cannotsend: "لا أستطيع إرسال البريد",
    l_keyboard: "لوحة المفاتيح لا تعمل", l_mouse: "الفأرة لا تعمل", l_slow: "الجهاز بطيء",
    l_print: "لا أستطيع الطباعة", l_jam: "انحشار ورق أو حبر قليل",
    l_internet: "لا يوجد إنترنت أو واي فاي", l_vpn: "لا أستطيع الاتصال بالشبكة الخاصة",
    l_password: "نسيت كلمة المرور", l_locked: "حسابي مقفل",
    l_assistant: "تحدث مع المساعد", l_person: "اطلب موظفاً",
    check_title: "تتبع تذكرتك", check_ph_id: "رقم التذكرة، مثل T0001", check_ph_contact: "رقمك الداخلي أو بريدك", check_btn: "تحقق",
    note: "فكرة المشروع: يحل الذكاء الاصطناعي المشاكل البسيطة أولاً، فلا تصل إلى فريق تقنية المعلومات إلا الحالات غير المحلولة.",
    footer: "مشروع تعليمي من أحد أعضاء فريق الخدمة في بنك البحرين الوطني. غير رسمي ولا تُستخدم أي بيانات حقيقية للموظفين.",
    chat_toggle: "تحتاج مساعدة؟ تحدث", chat_title: "مساعد تقنية المعلومات", chat_close: "إغلاق",
    ph_msg: "صف المشكلة", send: "إرسال", warn: "لا تكتب كلمات المرور هنا أبداً.", attach: "صورة",
    ticket_intro: "اترك بياناتك وسيتواصل معك فريق تقنية المعلومات.",
    ph_name: "اسمك", ph_contact: "الرقم الداخلي أو البريد", ph_place: "القسم ومكان المكتب أو الطابق", send_it: "إرسال إلى فريق تقنية المعلومات",
    greeting: "مرحباً، أنا مساعد تقنية المعلومات. أخبرني ما المشكلة، مثلاً أوتلوك أو لوحة المفاتيح أو الطابعة أو الشبكة.",
    ph_human: "اكتب لفريق تقنية المعلومات",
    it_team: "فريق تقنية المعلومات",
    fb_q: "هل حل هذا مشكلتك؟", fb_yes: "نعم، تم الحل", fb_no: "لا، ما زالت موجودة",
    need_text: "اكتب سؤالك أولاً ثم أضف لقطة الشاشة.",
    uploading: "جارٍ إرسال الصورة...",
    err_send: "عذراً، لم يتم الإرسال. حاول مرة أخرى.",
    ticket_thanks: "شكراً لك. رقم تذكرتك هو {id}. سيتواصل معك فريق تقنية المعلومات قريباً، أو يرد هنا مباشرة.",
    st_open: "تذكرتك {id} مفتوحة، وفريق تقنية المعلومات يعمل عليها.",
    st_solved: "تذكرتك {id} تم حلها.",
  };
  const EN = {
    greeting: "Hello, I am the IT help assistant. Tell me what is not working, for example Outlook, keyboard, printer or network.",
    ph_msg: "Describe the problem",
    ph_human: "Write to the IT team",
    it_team: "IT team",
    fb_q: "Did that fix it?", fb_yes: "Yes, fixed", fb_no: "No, still broken",
    need_text: "Write your question first, then add the screenshot.",
    uploading: "Sending the picture...",
    err_send: "Sorry, that did not send. Please try again.",
    ticket_thanks: "Thank you. Your ticket number is {id}. The IT team will contact you soon, or reply right here.",
    st_open: "Your ticket {id} is open and the IT team is working on it.",
    st_solved: "Your ticket {id} is solved.",
  };

  let lang = "en";
  try {
    lang = localStorage.getItem("lang") === "ar" ? "ar" : "en";
  } catch {
  }

  window.getLang = () => lang;
  window.t = (key, vars) => {
    let out = (lang === "ar" && AR[key]) || EN[key] || key;
    for (const k in vars || {}) out = out.replace("{" + k + "}", vars[k]);
    return out;
  };

  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      if (el.dataset.en === undefined) el.dataset.en = el.textContent;
      el.textContent = lang === "ar" && AR[el.dataset.i18n] ? AR[el.dataset.i18n] : el.dataset.en;
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      if (el.dataset.en === undefined) el.dataset.en = el.placeholder;
      el.placeholder = lang === "ar" && AR[el.dataset.i18nPh] ? AR[el.dataset.i18nPh] : el.dataset.en;
    });
    document.querySelectorAll("[data-ask-ar]").forEach((el) => {
      if (el.dataset.askEn === undefined) el.dataset.askEn = el.dataset.ask;
      el.dataset.ask = lang === "ar" ? el.dataset.askAr : el.dataset.askEn;
    });
    const button = document.getElementById("lang");
    if (button) button.textContent = lang === "ar" ? "English" : "العربية";
  }

  document.addEventListener("DOMContentLoaded", () => {
    apply();
    const button = document.getElementById("lang");
    if (button) {
      button.addEventListener("click", () => {
        lang = lang === "ar" ? "en" : "ar";
        try { localStorage.setItem("lang", lang); } catch { /* ignore */ }
        apply();
        document.dispatchEvent(new Event("langchange"));
      });
    }
  });
})();
