// Синтетический набор из 50 задач для A/B-бенчмарка Smart Engine v3.
//
// Распределение:
//   - 15 code-edit
//   - 15 reasoning
//   - 10 chat
//   - 10 tool-use
//
// Каждая задача — (id, category, prompt, expected_pattern, fake_v3_response,
// fake_baseline_response). `expected_pattern` — простая regex-подстрока для
// прохода. fake-ответы захардкожены: v3 отвечает хорошо (имитируем code- и
// fast-модели), gemma3:4b baseline — заметно хуже (это и есть гипотеза
// Phase 2: auto-prefer даёт лучшее качество на подходящих категориях).
//
// Реальные LLM не дёргаем — тестируем ЛОГИКУ auto-prefer, не качество моделей.

use super::smart_engine::TaskCategory;

#[derive(Debug, Clone)]
pub struct SynthTask {
    pub id: String,
    pub category: TaskCategory,
    pub prompt: String,
    /// Подстрока, которая должна быть в ответе, чтобы задача считалась passed.
    pub expected_substring: &'static str,
    /// Имитация ответа v3 (после auto-prefer). Короче и точнее.
    pub v3_response: &'static str,
    /// Имитация ответа baseline gemma3:4b. Более длинный, более "сбивчивый".
    pub baseline_response: &'static str,
    /// Симулированная latency v3 (мс) — "fast" модели 200ms, "code" 600ms.
    pub v3_latency_ms: u64,
    /// Симулированная latency baseline gemma3:4b (мс) — обычно 1500-2500.
    pub baseline_latency_ms: u64,
}

/// Сгенерировать 50 задач.
pub fn synthesize_tasks() -> Vec<SynthTask> {
    let mut out: Vec<SynthTask> = Vec::with_capacity(50);

    // ── 15 code-edit ──────────────────────────────────────────────────────
    out.push(SynthTask {
        id: "code-01".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши функцию `add(a: i32, b: i32) -> i32` на Rust которая складывает два числа".into(),
        expected_substring: "fn add",
        v3_response: "```rust\nfn add(a: i32, b: i32) -> i32 { a + b }\n```",
        baseline_response: "Here's the function you requested:\n```rust\nfn add(a: i32, b: i32) -> i32 {\n    return a + b;\n}\n```\nThis should work fine for your needs.",
        v3_latency_ms: 580,
        baseline_latency_ms: 2100,
    });
    out.push(SynthTask {
        id: "code-02".into(),
        category: TaskCategory::CodeEdit,
        prompt: "перепиши эту функцию чтобы она использовала `match` вместо if-else: ```rust\nfn check(x: i32) -> &'static str { if x > 0 { \"pos\" } else if x < 0 { \"neg\" } else { \"zero\" } }```".into(),
        expected_substring: "match ",
        v3_response: "```rust\nfn check(x: i32) -> &'static str {\n    match x {\n        x if x > 0 => \"pos\",\n        x if x < 0 => \"neg\",\n        _ => \"zero\",\n    }\n}\n```",
        baseline_response: "Sure! Here's the refactored version:\n```rust\nfn check(x: i32) -> &'static str {\n    if x > 0 { \"pos\" } else { \"neg\" }\n}\n```\nNote: I simplified the logic a bit for clarity.",
        v3_latency_ms: 620,
        baseline_latency_ms: 2300,
    });
    out.push(SynthTask {
        id: "code-03".into(),
        category: TaskCategory::CodeEdit,
        prompt: "объясни что делает этот код: ```rust\nlet v: Vec<i32> = (0..10).filter(|x| x % 2 == 0).collect();```".into(),
        expected_substring: "even",
        v3_response: "Создаёт вектор чётных чисел от 0 до 9: [0, 2, 4, 6, 8].",
        baseline_response: "This Rust code creates a vector of integers. The filter operation uses a closure to determine which elements to include based on a condition. The collect method gathers the results into a Vec<i32>.",
        v3_latency_ms: 410,
        baseline_latency_ms: 1900,
    });
    out.push(SynthTask {
        id: "code-04".into(),
        category: TaskCategory::CodeEdit,
        prompt: "добавь обработку ошибок в эту функцию с помощью `Result`: ```rust\nfn parse(s: &str) -> i32 { s.parse().unwrap() }```".into(),
        expected_substring: "Result",
        v3_response: "```rust\nfn parse(s: &str) -> Result<i32, std::num::ParseIntError> {\n    s.parse()\n}\n```",
        baseline_response: "Here's the updated function:\n```rust\nfn parse(s: &str) -> i32 {\n    match s.parse() {\n        Ok(n) => n,\n        Err(_) => 0,\n    }\n}\n```",
        v3_latency_ms: 540,
        baseline_latency_ms: 2050,
    });
    out.push(SynthTask {
        id: "code-05".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши трейт `Speak` с методом `speak(&self) -> String` и две реализации для `Dog` и `Cat`".into(),
        expected_substring: "trait Speak",
        v3_response: "```rust\ntrait Speak {\n    fn speak(&self) -> String;\n}\nstruct Dog;\nstruct Cat;\nimpl Speak for Dog { fn speak(&self) -> String { \"Woof\".into() } }\nimpl Speak for Cat { fn speak(&self) -> String { \"Meow\".into() } }\n```",
        baseline_response: "Sure! Here is a trait and implementations:\n```rust\ntrait Speak { fn speak(&self) -> String; }\nstruct Dog { name: String }\nstruct Cat { name: String }\nimpl Speak for Dog { fn speak(&self) -> String { format!(\"{} says woof\", self.name) } }\nimpl Speak for Cat { fn speak(&self) -> String { format!(\"{} says meow\", self.name) } }\n```",
        v3_latency_ms: 700,
        baseline_latency_ms: 2500,
    });
    out.push(SynthTask {
        id: "code-06".into(),
        category: TaskCategory::CodeEdit,
        prompt: "что выведет `println!` в этом коде и почему: ```rust\nlet s = String::from(\"hello\");\nlet s2 = s;\nprintln!(\"{}\", s);```".into(),
        expected_substring: "moved",
        v3_response: "Ошибка компиляции: `s` перемещён в `s2`, использовать `s` после перемещения нельзя. Нужно либо `clone()`, либо взять `&s`.",
        baseline_response: "The code will print \"hello\" because String implements Display. However, there might be a warning about the unused variable s2 depending on the compiler version.",
        v3_latency_ms: 480,
        baseline_latency_ms: 1950,
    });
    out.push(SynthTask {
        id: "code-07".into(),
        category: TaskCategory::CodeEdit,
        prompt: "конвертируй этот Python в Rust: ```python\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a```".into(),
        expected_substring: "fn fib",
        v3_response: "```rust\nfn fib(n: u32) -> u64 {\n    let (mut a, mut b) = (0u64, 1u64);\n    for _ in 0..n {\n        let c = a + b;\n        a = b;\n        b = c;\n    }\n    a\n}\n```",
        baseline_response: "Here's the Rust equivalent:\n```rust\nfn fib(n: u32) -> u32 {\n    if n == 0 { return 0; }\n    let mut result = vec![0, 1];\n    for i in 2..=n {\n        result.push(result[i-1] + result[i-2]);\n    }\n    result[n as usize]\n}\n```",
        v3_latency_ms: 720,
        baseline_latency_ms: 2700,
    });
    out.push(SynthTask {
        id: "code-08".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши макрос `vec_of_ten!` который создаёт `Vec<i32>` из 10 нулей".into(),
        expected_substring: "macro_rules!",
        v3_response: "```rust\nmacro_rules! vec_of_ten {\n    () => {{\n        let v: Vec<i32> = (0..10).map(|_| 0).collect();\n        v\n    }};\n}\n```",
        baseline_response: "```rust\nmacro_rules! vec_of_ten {\n    () => { vec![0; 10] };\n}\n```",
        v3_latency_ms: 510,
        baseline_latency_ms: 2150,
    });
    out.push(SynthTask {
        id: "code-09".into(),
        category: TaskCategory::CodeEdit,
        prompt: "у меня паника в `unwrap()`, как обработать это через `?` оператор: ```rust\nfn read() -> String { std::fs::read_to_string(\"f.txt\").unwrap() }```".into(),
        expected_substring: "Result",
        v3_response: "```rust\nfn read() -> Result<String, std::io::Error> {\n    std::fs::read_to_string(\"f.txt\")\n}\n```\nТеперь ошибка проброшена наверх через `?`.",
        baseline_response: "You can use the `?` operator like this:\n```rust\nfn read() -> String {\n    std::fs::read_to_string(\"f.txt\").unwrap_or_default()\n}\n```",
        v3_latency_ms: 600,
        baseline_latency_ms: 2200,
    });
    out.push(SynthTask {
        id: "code-10".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши generic функцию `largest<T: PartialOrd>(list: &[T]) -> &T` которая находит максимум в слайсе".into(),
        expected_substring: "PartialOrd",
        v3_response: "```rust\nfn largest<T: PartialOrd>(list: &[T]) -> &T {\n    let mut largest = &list[0];\n    for item in list {\n        if item > largest { largest = item; }\n    }\n    largest\n}\n```",
        baseline_response: "Here's a generic function:\n```rust\nfn largest<T>(list: &[T]) -> T where T: PartialOrd + Copy {\n    let mut max = list[0];\n    for &item in list.iter() {\n        if item > max { max = item; }\n    }\n    max\n}\n```",
        v3_latency_ms: 650,
        baseline_latency_ms: 2400,
    });
    out.push(SynthTask {
        id: "code-11".into(),
        category: TaskCategory::CodeEdit,
        prompt: "что делает lifetimes в Rust: `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str`".into(),
        expected_substring: "lifetime",
        v3_response: "Lifetime `'a` гарантирует, что возвращаемая ссылка живёт не меньше, чем самый короткий из входных `&str`. Это связывает время жизни выхода с временами жизни входов.",
        baseline_response: "Lifetimes in Rust are a way to tell the compiler how long references should be valid. The 'a is a lifetime parameter that applies to all the references in the function signature.",
        v3_latency_ms: 470,
        baseline_latency_ms: 2000,
    });
    out.push(SynthTask {
        id: "code-12".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши iterator adapter chain для: взять `vec![1,2,3,4,5]`, оставить только чётные, удвоить, собрать в `Vec<i32>`".into(),
        expected_substring: ".map",
        v3_response: "```rust\nlet v: Vec<i32> = vec![1,2,3,4,5].into_iter().filter(|x| x % 2 == 0).map(|x| x * 2).collect();\n```",
        baseline_response: "```rust\nlet v: Vec<i32> = vec![];\nfor x in vec![1,2,3,4,5] {\n    if x % 2 == 0 {\n        v.push(x * 2);\n    }\n}\n```",
        v3_latency_ms: 530,
        baseline_latency_ms: 2100,
    });
    out.push(SynthTask {
        id: "code-13".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши Tauri command с параметрами: `async fn greet(app: tauri::AppHandle, name: String) -> Result<String, String>`".into(),
        expected_substring: "tauri::command",
        v3_response: "```rust\n#[tauri::command]\nasync fn greet(app: tauri::AppHandle, name: String) -> Result<String, String> {\n    Ok(format!(\"Hello, {}!\", name))\n}\n```",
        baseline_response: "Here's a Tauri command:\n```rust\nfn greet(name: String) -> String {\n    format!(\"Hello, {}!\", name)\n}\n```\nNote: I'm not sure about the AppHandle parameter, you might not need it.",
        v3_latency_ms: 580,
        baseline_latency_ms: 2200,
    });
    out.push(SynthTask {
        id: "code-14".into(),
        category: TaskCategory::CodeEdit,
        prompt: "напиши `tokio::spawn` который считает hash файла в фоне и пишет результат в `mpsc::channel`".into(),
        expected_substring: "tokio::spawn",
        v3_response: "```rust\nlet (tx, mut rx) = tokio::sync::mpsc::channel(1);\ntokio::spawn(async move {\n    let bytes = tokio::fs::read(\"f.txt\").await.unwrap();\n    let hash = blake3::hash(&bytes).to_hex().to_string();\n    tx.send(hash).await.unwrap();\n});\n```",
        baseline_response: "You can use tokio::spawn like this:\n```rust\nlet handle = tokio::spawn(async {\n    // do something\n});\n```",
        v3_latency_ms: 700,
        baseline_latency_ms: 2500,
    });
    out.push(SynthTask {
        id: "code-15".into(),
        category: TaskCategory::CodeEdit,
        prompt: "что такое `impl Trait` vs `dyn Trait` в Rust, когда что использовать?".into(),
        expected_substring: "static",
        v3_response: "`impl Trait` — статическая диспетчеризация, мономорфизация на этапе компиляции, zero-cost. `dyn Trait` — динамическая диспетчеризация через vtable, нужна когда тип неизвестен до runtime (напр. коллекции разных типов).",
        baseline_response: "Both are ways to work with trait objects. impl Trait is for when you know the type at compile time, dyn Trait is for when you don't. They are similar but used in different contexts.",
        v3_latency_ms: 550,
        baseline_latency_ms: 2300,
    });

    // ── 15 reasoning ──────────────────────────────────────────────────────
    out.push(SynthTask {
        id: "reason-01".into(),
        category: TaskCategory::Reasoning,
        prompt: "если у Пети 5 яблок, а у Маши в 3 раза больше, сколько яблок у Маши?".into(),
        expected_substring: "15",
        v3_response: "5 * 3 = 15 яблок.",
        baseline_response: "У Пети 5 яблок. Если умножить на 3, получится 15. Ответ: 15 яблок у Маши.",
        v3_latency_ms: 180,
        baseline_latency_ms: 1500,
    });
    out.push(SynthTask {
        id: "reason-02".into(),
        category: TaskCategory::Reasoning,
        prompt: "поезд едет 60 км/ч, за 3 часа он проедет сколько километров?".into(),
        expected_substring: "180",
        v3_response: "60 * 3 = 180 км.",
        baseline_response: "При скорости 60 км/ч за 3 часа поезд преодолеет расстояние в 180 километров.",
        v3_latency_ms: 200,
        baseline_latency_ms: 1400,
    });
    out.push(SynthTask {
        id: "reason-03".into(),
        category: TaskCategory::Reasoning,
        prompt: "у квадрата периметр 20 см, чему равна сторона?".into(),
        expected_substring: "5",
        v3_response: "P = 4a → a = P/4 = 20/4 = 5 см.",
        baseline_response: "Периметр квадрата это сумма всех четырёх сторон. Если периметр 20 см, то одна сторона равна 5 см.",
        v3_latency_ms: 220,
        baseline_latency_ms: 1600,
    });
    out.push(SynthTask {
        id: "reason-04".into(),
        category: TaskCategory::Reasoning,
        prompt: "логическая задача: все кошки млекопитающие. Мурка — кошка. Значит ли это что Мурка млекопитающее?".into(),
        expected_substring: "да",
        v3_response: "Да. Если все кошки — млекопитающие, и Мурка — кошка, то Мурка — млекопитающее (силлогизм).",
        baseline_response: "Это вопрос логики и дедуктивного мышления. Мурка является кошкой, а кошки относятся к млекопитающим. Следовательно, Мурка тоже млекопитающее.",
        v3_latency_ms: 240,
        baseline_latency_ms: 1700,
    });
    out.push(SynthTask {
        id: "reason-05".into(),
        category: TaskCategory::Reasoning,
        prompt: "что больше: 2^10 или 10^3? Объясни почему.".into(),
        expected_substring: "1024",
        v3_response: "2^10 = 1024, 10^3 = 1000. 1024 > 1000, значит 2^10 больше.",
        baseline_response: "Давайте посчитаем. 2 в степени 10 это 1024. 10 в степени 3 это 1000. Сравниваем: 1024 и 1000. Получается 2^10 = 1024 больше.",
        v3_latency_ms: 230,
        baseline_latency_ms: 1550,
    });
    out.push(SynthTask {
        id: "reason-06".into(),
        category: TaskCategory::Reasoning,
        prompt: "у Вани 3 красных и 2 синих шара, какова вероятность вытащить красный?".into(),
        expected_substring: "3/5",
        v3_response: "P = красные / всего = 3 / 5 = 0.6 = 60%.",
        baseline_response: "Вероятность это отношение благоприятных исходов к общему числу. Красных 3, всего 5, значит 3/5 или 60%.",
        v3_latency_ms: 210,
        baseline_latency_ms: 1450,
    });
    out.push(SynthTask {
        id: "reason-07".into(),
        category: TaskCategory::Reasoning,
        prompt: "что тяжелее: килограмм пуха или килограмм железа?".into(),
        expected_substring: "одинаково",
        v3_response: "Одинаково. Килограмм — единица массы, и килограмм пуха = килограмм железа по массе (по веку в воздухе отличается на архимедову силу, но обычно имеется в виду масса).",
        baseline_response: "Это классическая загадка. Хотя пух выглядит легче, килограмм есть килограмм, поэтому они весят одинаково.",
        v3_latency_ms: 260,
        baseline_latency_ms: 1800,
    });
    out.push(SynthTask {
        id: "reason-08".into(),
        category: TaskCategory::Reasoning,
        prompt: "назови столицу Австралии".into(),
        expected_substring: "Канберра",
        v3_response: "Канберра.",
        baseline_response: "Столица Австралии — Канберра, а не Сидней, как многие ошибочно думают. Канберра была специально построена как столица.",
        v3_latency_ms: 150,
        baseline_latency_ms: 1300,
    });
    out.push(SynthTask {
        id: "reason-09".into(),
        category: TaskCategory::Reasoning,
        prompt: "сколько будет 17 * 23?".into(),
        expected_substring: "391",
        v3_response: "17 * 23 = 391.",
        baseline_response: "Давайте умножим 17 на 23. 17 * 20 = 340, 17 * 3 = 51. 340 + 51 = 391. Ответ: 391.",
        v3_latency_ms: 160,
        baseline_latency_ms: 1350,
    });
    out.push(SynthTask {
        id: "reason-10".into(),
        category: TaskCategory::Reasoning,
        prompt: "если 5 рабочих делают работу за 12 дней, за сколько дней сделают 10 рабочих?".into(),
        expected_substring: "6",
        v3_response: "Обратная пропорция: T = 5*12/10 = 6 дней.",
        baseline_response: "Это задача на обратную пропорциональность. Если рабочих в 2 раза больше, то времени понадобится в 2 раза меньше. 12 / 2 = 6 дней.",
        v3_latency_ms: 250,
        baseline_latency_ms: 1700,
    });
    out.push(SynthTask {
        id: "reason-11".into(),
        category: TaskCategory::Reasoning,
        prompt: "правда ли что все простые числа нечётные?".into(),
        expected_substring: "2",
        v3_response: "Нет. 2 — единственное чётное простое число. Все остальные простые числа нечётные (делятся на 2, кроме самой 2).",
        baseline_response: "Простые числа это числа, которые делятся только на 1 и на само себя. Да, большинство из них нечётные.",
        v3_latency_ms: 230,
        baseline_latency_ms: 1500,
    });
    out.push(SynthTask {
        id: "reason-12".into(),
        category: TaskCategory::Reasoning,
        prompt: "что больше: e^π или π^e? Объясни.".into(),
        expected_substring: "e^π",
        v3_response: "e^π ≈ 23.14, π^e ≈ 22.46. e^π > π^e.",
        baseline_response: "Это интересный вопрос. Обычно e^π больше, но без вычислений сложно сказать точно.",
        v3_latency_ms: 200,
        baseline_latency_ms: 1400,
    });
    out.push(SynthTask {
        id: "reason-13".into(),
        category: TaskCategory::Reasoning,
        prompt: "если я выйду из дома в 8:00 и буду идти со скоростью 5 км/ч, во сколько я дойду до работы на расстоянии 3 км?".into(),
        expected_substring: "8:36",
        v3_response: "3 км / 5 км/ч = 0.6 ч = 36 мин. 8:00 + 36 мин = 8:36.",
        baseline_response: "Время в пути = расстояние / скорость = 3 / 5 = 0.6 часа, это 36 минут. К 8:36 вы будете на месте.",
        v3_latency_ms: 220,
        baseline_latency_ms: 1600,
    });
    out.push(SynthTask {
        id: "reason-14".into(),
        category: TaskCategory::Reasoning,
        prompt: "что такое парадокс Банаха-Тарского в одном предложении?".into(),
        expected_substring: "шар",
        v3_response: "Парадокс Банаха-Тарского: шар можно разрезать на конечное число кусков и собрать из них два таких же шара (без растяжения).",
        baseline_response: "Это математический парадокс, связанный с бесконечными множествами и несохранением объёма при определённых разбиениях.",
        v3_latency_ms: 280,
        baseline_latency_ms: 1900,
    });
    out.push(SynthTask {
        id: "reason-15".into(),
        category: TaskCategory::Reasoning,
        prompt: "найди X: 3x + 7 = 22".into(),
        expected_substring: "5",
        v3_response: "3x = 22 - 7 = 15 → x = 5.",
        baseline_response: "Чтобы найти x, нужно изолировать переменную. 3x = 22 - 7 = 15. x = 15/3 = 5. Ответ: x = 5.",
        v3_latency_ms: 170,
        baseline_latency_ms: 1300,
    });

    // ── 10 chat ──────────────────────────────────────────────────────────
    out.push(SynthTask {
        id: "chat-01".into(),
        category: TaskCategory::Chat,
        prompt: "привет!".into(),
        expected_substring: "привет",
        v3_response: "Привет! Чем могу помочь?",
        baseline_response: "Привет! Я AI-ассистент, готов помочь с вашими вопросами. Что вас интересует сегодня?",
        v3_latency_ms: 90,
        baseline_latency_ms: 1200,
    });
    out.push(SynthTask {
        id: "chat-02".into(),
        category: TaskCategory::Chat,
        prompt: "как тебя зовут?".into(),
        expected_substring: "Pulse",
        v3_response: "Я Pulse — голосовой AI-ассистент.",
        baseline_response: "Меня зовут Pulse, я AI-ассистент разработанный для помощи с различными задачами.",
        v3_latency_ms: 100,
        baseline_latency_ms: 1100,
    });
    out.push(SynthTask {
        id: "chat-03".into(),
        category: TaskCategory::Chat,
        prompt: "спасибо".into(),
        expected_substring: "пожалуйста",
        v3_response: "Пожалуйста!",
        baseline_response: "Рад был помочь! Если что-то ещё понадобится, обращайтесь.",
        v3_latency_ms: 80,
        baseline_latency_ms: 1100,
    });
    out.push(SynthTask {
        id: "chat-04".into(),
        category: TaskCategory::Chat,
        prompt: "что ты умеешь?".into(),
        expected_substring: "запус",
        v3_response: "Могу запускать приложения, отвечать на вопросы, искать в интернете.",
        baseline_response: "Я многофункциональный AI-ассистент. Мои возможности включают ответы на вопросы, помощь с кодом, запуск приложений, поиск информации, перевод, и многое другое.",
        v3_latency_ms: 110,
        baseline_latency_ms: 1300,
    });
    out.push(SynthTask {
        id: "chat-05".into(),
        category: TaskCategory::Chat,
        prompt: "расскажи анекдот".into(),
        expected_substring: "программист",
        v3_response: "Почему программист носит очки? Потому что не может C#.",
        baseline_response: "Вот анекдот: Штирлиц стрелял вслепую. Слепая упала. Штирлиц подбросил слепую к потолку. Слепая прилипла к потолку и закричала: \"Снимите меня!\" Штирлиц снял.",
        v3_latency_ms: 130,
        baseline_latency_ms: 1500,
    });
    out.push(SynthTask {
        id: "chat-06".into(),
        category: TaskCategory::Chat,
        prompt: "пока".into(),
        expected_substring: "пока",
        v3_response: "Пока! Возвращайся.",
        baseline_response: "До свидания! Хорошего дня и хорошего настроения! Буду рад помочь снова в будущем.",
        v3_latency_ms: 70,
        baseline_latency_ms: 1000,
    });
    out.push(SynthTask {
        id: "chat-07".into(),
        category: TaskCategory::Chat,
        prompt: "как дела?".into(),
        expected_substring: "хорошо",
        v3_response: "Хорошо, спасибо! У тебя как?",
        baseline_response: "У меня всё отлично, спасибо что спросили! Я готов помочь с любыми вопросами или задачами. А у вас как дела?",
        v3_latency_ms: 100,
        baseline_latency_ms: 1200,
    });
    out.push(SynthTask {
        id: "chat-08".into(),
        category: TaskCategory::Chat,
        prompt: "который час?".into(),
        expected_substring: ":",
        v3_response: "Точное время зависит от твоей таймзоны, но я думаю около 14:00 по Москве если ты в МСК.",
        baseline_response: "К сожалению я не знаю текущего времени, так как не имею доступа к системным часам. Пожалуйста, посмотрите на часы вашего устройства.",
        v3_latency_ms: 90,
        baseline_latency_ms: 1300,
    });
    out.push(SynthTask {
        id: "chat-09".into(),
        category: TaskCategory::Chat,
        prompt: "скучно".into(),
        expected_substring: "игра",
        v3_response: "Могу запустить игру — Steam открыть?",
        baseline_response: "Понимаю, скука это неприятно. Могу предложить несколько вариантов: запустить игру, найти интересную статью в интернете, или просто поговорить на любую тему.",
        v3_latency_ms: 110,
        baseline_latency_ms: 1400,
    });
    out.push(SynthTask {
        id: "chat-10".into(),
        category: TaskCategory::Chat,
        prompt: "ты милый".into(),
        expected_substring: "🙂",
        v3_response: "Спасибо 🙂",
        baseline_response: "Спасибо за добрые слова! Я стараюсь быть полезным и приятным в общении. Если что-то нужно — обращайтесь!",
        v3_latency_ms: 90,
        baseline_latency_ms: 1100,
    });

    // ── 10 tool-use ──────────────────────────────────────────────────────
    out.push(SynthTask {
        id: "tool-01".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"web_search","args":{"query":"rust async tutorial"}}"#.into(),
        expected_substring: "web_search",
        v3_response: r#"{"name":"web_search","result":"Found 8 results for 'rust async tutorial'"}"#,
        baseline_response: "I'll search the web for you. The search returned several results about Rust async programming including the official tokio documentation and various tutorials.",
        v3_latency_ms: 250,
        baseline_latency_ms: 1700,
    });
    out.push(SynthTask {
        id: "tool-02".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"list_installed_apps","args":{}}"#.into(),
        expected_substring: "list_installed_apps",
        v3_response: r#"{"name":"list_installed_apps","result":["Firefox","VS Code","Steam","Discord"]}"#,
        baseline_response: "I'll run list_installed_apps. The function returned a list of installed applications on your system.",
        v3_latency_ms: 200,
        baseline_latency_ms: 1500,
    });
    out.push(SynthTask {
        id: "tool-03".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"open_app","args":{"name":"firefox"}}"#.into(),
        expected_substring: "open_app",
        v3_response: r#"{"name":"open_app","result":"launched firefox"}"#,
        baseline_response: "I'll open firefox for you. The application has been launched successfully.",
        v3_latency_ms: 220,
        baseline_latency_ms: 1600,
    });
    out.push(SynthTask {
        id: "tool-04".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"get_system_info","args":{}}"#.into(),
        expected_substring: "system",
        v3_response: r#"{"name":"get_system_info","result":{"cpu":"i7","ram_gb":16,"os":"Windows 11"}}"#,
        baseline_response: "Let me check your system information. The get_system_info function returns details about your computer's hardware and OS.",
        v3_latency_ms: 180,
        baseline_latency_ms: 1400,
    });
    out.push(SynthTask {
        id: "tool-05".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"list_games","args":{}}"#.into(),
        expected_substring: "list_games",
        v3_response: r#"{"name":"list_games","result":["Stardew Valley","Hades","Civilization VI"]}"#,
        baseline_response: "I'll list your games. The system found several games installed on your machine.",
        v3_latency_ms: 210,
        baseline_latency_ms: 1550,
    });
    out.push(SynthTask {
        id: "tool-06".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"youtube_search","args":{"query":"rust tutorial"}}"#.into(),
        expected_substring: "youtube",
        v3_response: r#"{"name":"youtube_search","result":["Rust in 100 seconds","Rust full course"]}"#,
        baseline_response: "I'll search YouTube for 'rust tutorial'. The search returned several videos matching your query.",
        v3_latency_ms: 240,
        baseline_latency_ms: 1650,
    });
    out.push(SynthTask {
        id: "tool-07".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"habr_search","args":{"query":"tauri 2"}}"#.into(),
        expected_substring: "habr",
        v3_response: r#"{"name":"habr_search","result":["Tauri 2.0 release notes","Tauri vs Electron"]}"#,
        baseline_response: "I'll search Habr for 'tauri 2'. The search returned several relevant articles about Tauri 2.",
        v3_latency_ms: 230,
        baseline_latency_ms: 1600,
    });
    out.push(SynthTask {
        id: "tool-08".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"set_volume","args":{"level":50}}"#.into(),
        expected_substring: "set_volume",
        v3_response: r#"{"name":"set_volume","result":"volume set to 50%"}"#,
        baseline_response: "I'll set the system volume to 50%. The audio level has been adjusted.",
        v3_latency_ms: 100,
        baseline_latency_ms: 1200,
    });
    out.push(SynthTask {
        id: "tool-09".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"take_screenshot","args":{}}"#.into(),
        expected_substring: "screenshot",
        v3_response: r#"{"name":"take_screenshot","result":"saved to /tmp/screen.png"}"#,
        baseline_response: "I'll take a screenshot of your current screen. The image has been captured.",
        v3_latency_ms: 280,
        baseline_latency_ms: 1800,
    });
    out.push(SynthTask {
        id: "tool-10".into(),
        category: TaskCategory::ToolUse,
        prompt: r#"{"name":"clipboard_set","args":{"text":"hello"}}"#.into(),
        expected_substring: "clipboard",
        v3_response: r#"{"name":"clipboard_set","result":"clipboard updated"}"#,
        baseline_response: "I'll set the clipboard contents to 'hello'. The text has been copied to your clipboard.",
        v3_latency_ms: 100,
        baseline_latency_ms: 1100,
    });

    assert_eq!(out.len(), 50, "synthesize_tasks must produce exactly 50 tasks");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fifty_tasks_across_four_categories() {
        let tasks = synthesize_tasks();
        let mut counts = std::collections::HashMap::<&str, usize>::new();
        for t in &tasks {
            *counts.entry(t.category.as_str()).or_insert(0) += 1;
        }
        assert_eq!(tasks.len(), 50);
        assert_eq!(counts.get("code-edit").copied().unwrap_or(0), 15);
        assert_eq!(counts.get("reasoning").copied().unwrap_or(0), 15);
        assert_eq!(counts.get("chat").copied().unwrap_or(0), 10);
        assert_eq!(counts.get("tool-use").copied().unwrap_or(0), 10);
    }

    #[test]
    fn unique_task_ids() {
        let tasks = synthesize_tasks();
        let mut seen = std::collections::HashSet::<&str>::new();
        for t in &tasks {
            assert!(seen.insert(&t.id), "duplicate id: {}", t.id);
        }
    }
}
