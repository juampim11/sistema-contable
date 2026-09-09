# 30 — Preguntas de producto abiertas

> Estas discusiones ocurrieron en el chat de Claude.ai (paralelo a las sesiones de Claude Code) y no
> tenían ningún documento del repo que las contuviera — quedaban solo en la memoria de JP y en un chat
> que no persiste acá. Este documento existe para que no se pierdan. Ninguna de las tres preguntas
> tiene código escrito todavía; son decisiones de alcance/producto, no de implementación.

## a) Alta de proveedores: ¿reactiva o proactiva? — y qué pasa con un cliente sin proveedores cargados

**La pregunta de JP:** hoy `padron_contraparte` se carga proveedor por proveedor, confirmado nombre por
nombre contra la contadora (ver HANDOFF 184, los 7 de Bracci). Eso es necesariamente **reactivo**: un
proveedor se da de alta cuando alguien lo identifica como relevante, no de antemano. La pregunta es si
eso está bien así, o si hace falta algún mecanismo **proactivo** (por ejemplo, alta en bloque desde un
padrón externo, o alta disparada automáticamente por volumen de apariciones sin match).

**El análisis, ya hecho (sin resolver en código):** el estado real de un cliente CON el padrón todavía
incompleto es que la mayoría de sus movimientos van a caer en `patron_contraparte_estado = 'sin_match'`
— y **eso es el estado normal esperado**, no una excepción que haya que programar ni un bug a corregir.
El sistema entero está diseñado para tolerar `sin_match` sin romperse: Capa D no exige contraparte
resuelta para proponer un asiento, la cola de revisión de la contadora ya maneja `decision_humana` sin
contraparte, y el propio `resolverEvidenciaDeContraparte` es TOTAL sobre sus 7 ramas de entrada,
incluida la que da `sin_match`. Un cliente nuevo con el padrón vacío no está en un estado degradado que
necesite arreglo: está en el estado inicial correcto, que se va completando reactivamente a medida que
la contadora identifica proveedores reales.

**Lo que queda sin decidir:** si alguna vez conviene un mecanismo proactivo (por ejemplo, un reporte
periódico de "las N contrapartes con más apariciones en `sin_match`, para que la contadora decida cuáles
vale la pena cargar" — algo parecido en espíritu al corte de Hoja 1 del relevamiento de Laura, HANDOFF
171). Ningún diseño concreto todavía. No bloquea nada hoy.

## b) Qué falta para una demo/producto real, más allá del ciclo actual con Laura (Excel)

El ciclo de hoy es: Capa D genera asientos → se exporta a Excel (`exportar-relevamiento-laura.ts`,
`exportar-excel.ts`) → la contadora lo revisa fuera del sistema → el feedback vuelve por WhatsApp/reunión
→ alguien lo traduce de vuelta a cambios en el sistema (altas de `regla_imputacion`, de
`padron_contraparte`, etc.). Funciona, pero el Excel es un puente manual, no un producto.

**Las fases identificadas para cerrar esa brecha, en orden, ninguna empezada:**

1. **Vista de solo lectura sobre Capa D.** Una pantalla (no un Excel) donde la contadora vea los
   `asiento_propuesto` generados, con su evidencia — el mismo contenido que hoy sale por Excel, pero
   navegable en vivo contra la base real, sin re-exportar cada vez que algo cambia.
2. **Aprobación en pantalla.** Sobre esa misma vista, la capacidad de que la contadora marque un asiento
   como revisado/aprobado — que es, en los hechos, la transición `asiento_estado: 'propuesto' →
   'confirmado'` que ya existe en el esquema desde `0027`/`0028` y que hoy nadie invoca en producción
   (el hallazgo que motivó el reproceso de Capa D, HANDOFF 188) — pero disparada por la contadora desde
   una pantalla, no por un CLI que corre JP a mano vía `confirmar-asientos.ts`.
3. **Carga de documentos desde la UI.** Que el extracto bancario / resumen de tarjeta / liquidación de
   FCI entre al sistema por una pantalla de subida, no por un CLI (`ingestar.ts`) que corre JP contra
   `privado/`. Es la fase que más se acerca a "producto que un cliente real usaría sin depender de
   alguien con acceso a la terminal". **Visión de producto para esta pantalla, ya registrada:** ver
   `docs/diseno/31-replanteo-hacia-producto.md`, nota sobre la Tanda 4 (2026-09-09) — nivel visual
   alto, no un dropdown de texto plano (ej. logo real de cada banco al elegir cuál extracto se sube).

Ninguna de las tres tiene ni siquiera un `docs/diseno/` de arquitectura propio todavía — `apps/web` no
existe en el repo (el roster de agentes ya tiene `frontend-dev`/`ux-designer` previstos para cuando
arranque, ver `CLAUDE.md` §3). Es explícitamente la brecha entre "el motor funciona y está probado
contra datos reales" y "hay un producto que alguien fuera de este equipo puede operar solo".

## c) "Cierre formal = balance, no mes a mes" — criterio de JP, estado: SIGUE ABIERTO

**El criterio, tal como lo planteó JP:** el cierre formal de un cliente —el evento real que dispara
"esto ya es definitivo, no se toca más"— es el **balance** (el ejercicio completo), no cada mes
individual. Un mes puede estar "andado"/revisado sin que eso constituya un cierre formal en el sentido
contable/legal del término.

**Verificado contra el repo, no asumido:** este criterio **NO quedó resuelto** por `contador-dominio` en
la convocatoria del reproceso de Capa D (HANDOFF 187-188, migración `0040`) — esa convocatoria usó
`asiento_estado: 'confirmado'` como el discriminador de "¿ya se revisó/entregó este asiento?", que es un
concepto de **revisión operativa** (mes a mes, asiento a asiento), explícitamente **no** el mismo
concepto que "cierre formal de balance". El propio diseño de `cierre_cliente_periodo` (D-1,
`docs/diseno/23-arquitectura-cierre-mensual.md`) ya prevé la distinción a nivel de esquema —
`tipo_periodo` acepta `'mensual'` **y** `'ejercicio'` desde el día uno, mecanismo construido pero sin
ningún flujo real que hoy dé de alta ni cierre un período de tipo `'ejercicio'`.

**Lo que falta, sin dueño todavía:** una convocatoria propia (`contador-dominio` + `arquitecto-software`)
sobre qué significa en este sistema el cierre de un **ejercicio** completo — si es una transición nueva
de `cierre_cliente_periodo` con `tipo_periodo = 'ejercicio'`, cómo se relaciona con los cierres mensuales
que lo componen (¿los exige todos confirmados primero?), y qué le pasa a un `asiento_propuesto` una vez
que el ejercicio (no solo el mes) está cerrado — probablemente un tercer nivel de inmutabilidad, más
fuerte que `'confirmado'`. Ninguna decisión tomada todavía; se deja consignada acá para que la próxima
convocatoria no la trate como pregunta nueva.
