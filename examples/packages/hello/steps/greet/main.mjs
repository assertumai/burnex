// Шаг на голом контракте: вход и выход — файлы, названные переменными
// окружения, ни одного импорта из stepcast.
import { readFileSync, writeFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(process.env.BURNEX_INPUT, 'utf8'));
writeFileSync(process.env.BURNEX_OUTPUT, JSON.stringify({ greeting: `привет, ${input.name ?? 'мир'}` }));
