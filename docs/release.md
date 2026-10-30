# Выпуск версии

Версия выходит двумя путями из одного тега: `install.sh` ставит движок по тегу
`vX.Y.Z`, `npm publish` публикует пакет с той же версией. Порядок ниже.

## Порядок выпуска

1. Дерево чистое, `npm run check` зелёный, ветка — та, что выпускается.
2. `npm version X.Y.Z` — поднимает `version` в `package.json` и
   `package-lock.json`, делает коммит и ставит тег `vX.Y.Z` одним шагом.
   Править версию руками и тегировать отдельно не нужно: именно так тег и
   версия расходятся.
3. `git push --follow-tags` — отправляет коммит и тег.
4. `npm publish` — из чекаута этого тега (`git checkout vX.Y.Z`). `prepack`
   сам запускает `npm run build`, так что забытая сборка в реестр не уедет;
   `files` в `package.json` перечисляет поставку (`dist`, `schema`,
   `src/builtin`), `publishConfig.access` держит пакет публичным.

## Тег и версия обязаны совпадать

По тегу ставит `install.sh`, по версии — npm. Если тег `v0.3.0` указывает на
коммит с `"version": "0.4.0"`, получатся две разные «0.3.0». Поэтому
`install.sh` при установке тега `vX.Y.Z` сверяет его с `version` собранного
`package.json` и отказывает, называя обе версии.

## Занятое имя

Если имя `stepcast` в реестре npm занято, пакет выпускается под scope:
меняется `name` в `package.json` (например, `@assertumai/stepcast`), а
способ установки `npm` в паспорте (`install.json`) называет это же имя —
`stepcast update` ставит `npm install -g <name>@<ссылка>`.

## Откат релиза

Каждая версия лежит в своём каталоге `~/.stepcast/releases/<имя>`, а
`current` — ссылка на один из них. Откат — переключение ссылки обратно:

```sh
ln -sfn ~/.stepcast/releases/<прежняя> ~/.stepcast/releases/current
```

Старые релизы не удаляются сами (уборка — отдельный пункт). После отката
перезапустите витрину: `stepcast down && stepcast up` в каталоге проекта, а
агент launchd — `launchctl kickstart -k gui/$(id -u)/ai.stepcast.daemon`.

## Открытый вопрос: первый тег

Пока в репозитории нет ни одного тега `vX.Y.Z`, `install.sh` без `--ref`
ставить нечего и отказывает. Нужен ли первый тег до слияния, решает человек
при выпуске; до тех пор установка идёт с явной ссылкой:

```sh
curl -fsSL https://raw.githubusercontent.com/assertumai/stepcast/main/scripts/install.sh | bash -s -- --ref main
```
