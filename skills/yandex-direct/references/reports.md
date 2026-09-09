# Отчёты Директа

Служба `reports` — основной инструмент счёта и единственная с асинхронным протоколом.

```bash
yandex-direct-mcp call reports.get \
  --ReportType CAMPAIGN_PERFORMANCE_REPORT \
  --FieldNames CampaignId --FieldNames CampaignName \
  --FieldNames Impressions --FieldNames Clicks --FieldNames Cost \
  --DateRangeType LAST_30_DAYS
```

## Как он себя ведёт

- Ответ приходит не сразу: `201` поставлен в очередь, `202` считается, `200` готов.
  Повтор идёт с тем же `ReportName` — имя и есть ключ задачи. Команда ждёт сама.
- Суммы запрашиваются в единицах валюты счёта принудительно. По умолчанию API отдаёт их
  умноженными на миллион: `Cost 1234500000` и `1234.50` — одна и та же сумма.
- Пропуск обозначается `--`, а не нулём и не пустой ячейкой.
- Синхронный вызов на большом окне отдаёт `504`, а не данные.

## Типы отчётов

- `ACCOUNT_PERFORMANCE_REPORT`
- `ADGROUP_PERFORMANCE_REPORT`
- `AD_PERFORMANCE_REPORT`
- `CAMPAIGN_PERFORMANCE_REPORT`
- `CRITERIA_PERFORMANCE_REPORT`
- `CUSTOM_REPORT`
- `REACH_AND_FREQUENCY_PERFORMANCE_REPORT`
- `SEARCH_QUERY_PERFORMANCE_REPORT`

## Периоды

- `ALL_TIME`
- `AUTO`
- `CUSTOM_DATE`
- `LAST_14_DAYS`
- `LAST_30_DAYS`
- `LAST_365_DAYS`
- `LAST_3_DAYS`
- `LAST_5_DAYS`
- `LAST_7_DAYS`
- `LAST_90_DAYS`
- `LAST_BUSINESS_WEEK`
- `LAST_MONTH`
- `LAST_WEEK`
- `LAST_WEEK_SUN_SAT`
- `THIS_MONTH`
- `THIS_WEEK_MON_TODAY`
- `THIS_WEEK_SUN_TODAY`
- `TODAY`
- `YESTERDAY`

## Ограничения, на которых спотыкаются

- `AttributionModels` допустимы ТОЛЬКО вместе с `Goals`.
- `Filter` — всегда массив, даже для одного условия.
- `ImpressionShare` запрещён в `CUSTOM_REPORT`; в `CAMPAIGN_PERFORMANCE_REPORT`
  разрешён, но у поисковых кампаний приезжает `--`.
- Колонки целей приезжают с суффиксами: `Conversions_<goalId>_<attribution>`.
- Полный список полей: https://yandex.ru/dev/direct/doc/ru/reports/fields-list

## Зачем отчёт даже там, где хватило бы списка

Кампании Мастера кампаний не отдаются методом `campaigns.get` вовсе — ни списком,
ни по явному `Ids`; ответ пустой и без ошибки. При этом откручиваться они могут
наравне с остальными и давать основную долю показов. Отчёт видит всё, что
откручивалось, поэтому состав кабинета определяется отсюда.
