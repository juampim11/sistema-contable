---
name: nacional-ganancias-computo-impuesto-creditos-y-debitos
description: Cómputo a cuenta de Ganancias (y Ganancia Mínima Presunta) del impuesto sobre los créditos y débitos bancarios (Ley 25413) — porcentajes generales y por categoría MiPyME.
nivel: nacional
impuesto: ganancias
sources_status: cargado-verificado-parcial
periodo: vigente al 2026-09-18 (norma sin período fiscal propio — rige por ejercicio en curso, sujeto a modificación futura)
compilado: 2026-09-18
verificado: 2026-09-18
---

# Cómputo a cuenta de Ganancias del impuesto sobre créditos y débitos bancarios (Ley 25413)

> **Cómo se cargó esto**: investigado y verificado por Claude vía búsqueda web (`WebSearch`/`WebFetch`),
> a pedido del titular, cruzando múltiples fuentes independientes — **no** contra el Boletín Oficial
> descargado directamente, y **no** por un profesional matriculado. Tratar como punto de partida
> razonable para que `fiscal-nacional-iva-ganancias` no arranque de cero, **nunca como fuente
> definitiva**. **Validar con profesional matriculado antes de aplicar esto a un caso real.**

## 1. Norma — Decreto 409/2018, modifica el art. 13 del Anexo del Decreto 380/2001 [VERIFICADO]

Confirmado por lectura directa del texto en `servicios.infoleg.gob.ar` (fuente oficial —
`infoleg.gob.ar`, la fuente primaria que indica `docs/agents/guia-carga-conocimiento.md` §1.2 para
Ganancias). El Decreto 409/2018 reemplaza el artículo 13 del Anexo del Decreto 380/2001, que regula
cómo el Impuesto sobre los Créditos y Débitos en Cuentas Bancarias (Ley 25413) puede computarse como
**pago a cuenta** del Impuesto a las Ganancias, del Impuesto a la Ganancia Mínima Presunta, o de la
Contribución Especial sobre el Capital de las Cooperativas.

## 2. Porcentajes de cómputo — régimen general [VERIFICADO]

- **33%** — sujetos gravados a la alícuota general (6‰ o 12‰, según el hecho imponible): pueden
  computar como crédito de impuestos el 33% de los importes ingresados por cuenta propia o
  liquidados/percibidos por el agente de percepción.
- **20%** — cuando el hecho imponible está alcanzado a una alícuota menor a las anteriores: el cómputo
  baja al 20%.

Texto citado del Decreto (vía `infoleg.gob.ar`): *"podrán computar como crédito de impuestos [...] el
TREINTA Y TRES POR CIENTO (33%)"* / *"el cómputo como crédito [...] será del VEINTE POR CIENTO (20%)"*.

## 3. Porcentajes diferenciados por categoría MiPyME [VERIFICADO, con matiz de fuente]

El **Artículo 2°** del Decreto 409/2018 incrementa el cómputo para empresas alcanzadas por la **Ley
27.264** (régimen MiPyME), modificando su artículo 6°. El desglose por categoría, citado tal cual:

| Categoría | % computable | Texto citado |
|---|---|---|
| **Micro y Pequeña Empresa** | **100%** | *"100% de los importes liquidados y percibidos [...] originados en las sumas acreditadas y debitadas por las empresas que sean consideradas 'micro' y 'pequeñas'"* |
| **Mediana — Tramo 1** | **60%** | *"60% de los importes liquidados y percibidos [...] originados en las sumas acreditadas y debitadas por las industrias manufactureras consideradas 'medianas -tramo 1-'"* |
| **Mediana — Tramo 2** | **sin dato encontrado** | Ninguna de las fuentes consultadas especifica un porcentaje diferenciado para Mediana Tramo 2 — puede regir el 33% general, o puede haber una norma posterior no localizada en esta carga. **[A VERIFICAR]** antes de usar. |

Categorías definidas, según las fuentes consultadas, por Resolución 340/17 SEPYME y Resolución 154/18
SEPYME — **normas de categorización que no son las mismas** que la Resolución 1/2026 SICyPyME cargada en
`categorizacion-mipyme.md` (ver ese archivo): los topes de facturación se actualizan periódicamente y
la resolución vigente al momento del ejercicio que se liquide puede no ser la misma que definió
originalmente el vínculo con este beneficio. **No asumir que la resolución de categorización de 2026
es la misma que originó este beneficio en 2018** — verificar si el beneficio del Decreto 409/2018 se
aplica hoy a la categorización VIGENTE al momento del pago, o a la vigente en 2018.

**Matiz de fuente**: el texto de estos tres porcentajes se tomó de una fuente secundaria
(`blogdelcontador.com.ar`) que cita el decreto entre comillas, y se cruzó contra una segunda fuente
independiente (`arca.gob.ar`, portal oficial del organismo recaudador) que reporta los mismos tres
números (33% general / 100% micro-pequeña / 60% mediana tramo 1). No se recontrastó este párrafo
específico contra el texto completo de `infoleg.gob.ar` en esta carga — el fetch a infoleg confirmó el
régimen general (33%/20%) y el mecanismo del remanente (§4), no releyó el Artículo 2° completo.

## 4. Remanente no computado — DISCREPANCIA REAL ENTRE FUENTES, sin resolver [A VERIFICAR]

Dos fuentes dan respuestas DISTINTAS sobre qué pasa con la porción del crédito que no se pudo usar en
el período — no se resuelve acá a criterio propio, se deja señalado:

- **`infoleg.gob.ar` (texto del decreto, vía Decreto 380/2001 art. 13 modificado)**: el remanente
  *"pudiendo trasladarse, **hasta su agotamiento**, a otros períodos fiscales de los citados
  tributos"* — sin límite temporal explícito, y sin mencionar un tope al monto trasladable. Nunca es
  de libre disponibilidad: *"no podrá ser objeto, bajo ninguna circunstancia, de compensación con
  otros gravámenes a cargo del contribuyente o de solicitudes de reintegro o transferencia a favor de
  terceros"* — solo aplicable contra Ganancias, Ganancia Mínima Presunta o Contribución Especial sobre
  el Capital de las Cooperativas.
- **`arca.gob.ar` (según el fetch de esta carga)**: agrega que, específicamente **para micro, pequeñas
  y medianas empresas, "solo el 33% del saldo remanente puede trasladarse a ejercicios futuros"** —
  una restricción adicional que el texto de `infoleg.gob.ar` consultado en esta carga NO menciona.

**No se sabe, con lo cargado hoy, cuál de las dos es la vigente/correcta** — puede ser que
`arca.gob.ar` cite una reglamentación posterior no localizada en este relevamiento, o puede ser una
imprecisión de esa fuente. **No aplicar el límite del 33% al remanente sin confirmar contra el texto
completo y vigente de la reglamentación** (posiblemente una RG de ARCA que instrumente el Decreto
409/2018, no localizada en esta carga — ver hueco en `_FUENTES.md`).

## 5. Lo que esta carga NO resuelve

- El % exacto para Mediana Tramo 2.
- La discrepancia del punto 4 (remanente: ¿trasladable hasta agotarse, o topeado al 33%?).
- Si la categorización MiPyME que define el % de ESTE beneficio es la vigente a la fecha del pago del
  impuesto, o la vigente en el ejercicio de la Ley 27.264 originaria (2018).
- Cualquier modificación posterior a 2018 sobre estos porcentajes — esta carga no verificó si hubo
  actualizaciones normativas entre 2018 y 2026.

## Fuentes consultadas (cita completa, con fecha de acceso 2026-09-18)

- [Decreto 409/2018 — texto completo, Infoleg](https://servicios.infoleg.gob.ar/infolegInternet/anexos/305000-309999/309791/norma.htm) — fuente oficial, usada para §1, §2, §4.
- [Beneficios Para PyMES: Aumentan el Monto del Pago a Cuenta de Ganancias por el Impuesto al Cheque — Blog del Contador](http://blogdelcontador.com.ar/beneficios-para-pymes-aumentan-el-monto-del-pago-a-cuenta-de-ganancias-por-el-impuesto-al-cheque) — fuente secundaria, usada para §3 (cita textual del decreto).
- [ARCA — Cómputo en Ganancias](https://www.arca.gob.ar/creditosyDebitos/casos-especiales/computo-en-ganancias.asp) — portal oficial del organismo recaudador, usado para cruzar §3 y como origen de la discrepancia de §4.
- [Impuesto al cheque: oficializan cambios en el cómputo del pago a cuenta en Ganancias — iProfesional](https://www.iprofesional.com/impuestos/267845-afip-iva-impuestos-Impuesto-al-cheque-oficializan-cambios-en-el-computo-del-pago-a-cuenta-en-Ganancias) — confirma §2, no aporta sobre §3.
- [Certificado PYME 2026... — Contadores en red](https://contadoresenred.com/impuesto-al-cheque-computo-decreto-409-2018/) — confirma la existencia de las tres categorías (general/micro-pequeña/mediana tramo 1), sin el detalle numérico completo en texto plano.

**Validar con profesional matriculado antes de aplicar cualquiera de estos porcentajes a un caso real.**
