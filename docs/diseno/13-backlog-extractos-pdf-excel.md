# 13 — Backlog: ¿PDF + Excel como fuentes complementarias del extracto bancario?

> 🔴 **INVESTIGACIÓN ABIERTA, SIN CERRAR. Nada de esto está decidido.** No hay diseño, no hay
> plan, no hay convocatoria hecha. Es el registro del problema, identificado a mitad de
> investigación en la sesión que lo escribió — para que la próxima sesión no lo pierda ni lo
> confunda con el plan de cotización BNA (`12-cotizacion-bna-plan.md`), que es un frente
> **independiente**, sin relación con este.

## El origen

JP preguntó si se puede resolver la dirección (débito/crédito) de `TRANSF. CTAS PROPIAS` en
Galicia mirando el extracto a fondo — hoy es una pregunta abierta en el catálogo
(`transferencia_cuentas_propias`, `pendienteDeLaura` en `catalogo.ts`, sin tocar en esta sesión
a propósito). Mencionó que los bancos suelen ofrecer el extracto en más de un formato — PDF y
Excel — y que, según Laura, el PDF a veces trae detalle que el Excel no tiene. Pero podría ser
al revés específicamente para el dato de cuenta destino de una transferencia entre cuentas
propias — no hay evidencia todavía en ningún sentido.

JP recuerda que en sesiones previas a este cambio de cuenta (de Claude Code), ya se vieron los
archivos Excel **nativos del banco** en `privado/extractos/` — no solo el PDF. **Esto NO se
verificó todavía en esta sesión.** No confirmar ni descartar sin evidencia: es exactamente el
tipo de cosa que este repo ya aprendió a no asumir (memoria de la lección: "verificar contra el
documento real, no contra lo que alguien recuerda que decía").

## Qué falta investigar, en orden

1. **Qué archivos existen realmente en `privado/extractos/`, para cada banco/cliente** — PDF,
   Excel nativo del banco, o ambos. (Nota: durante esta misma sesión, en el diagnóstico del gap
   de Galicia, se encontraron varios formatos mezclados bajo `privado/extractos/Sistematizacion
   Conciliacion Bancaria/` — PDF, `.xls` que en realidad eran texto plano tipo TSV, y `.xlsx`
   binarios reales. No se hizo un inventario sistemático por banco/cliente; fue exploración
   puntual para un caso distinto.)
2. **Si hay evidencia en el repo** (código, comentarios, `git log`, entradas viejas de
   `HANDOFF.md`) de que algún Excel nativo ya se haya inspeccionado o usado para algo — aunque
   sea como referencia descartada. No asumir que "nunca se miró" ni que "ya se usó" sin
   confirmarlo contra el propio repo.
3. **Si el Excel nativo de Galicia trae algún dato de cuenta destino/CBU/CVU** en las
   transferencias entre cuentas propias que el PDF no tiene — esta es la pregunta que, si se
   contesta que sí, cerraría (o acotaría) el `pendienteDeLaura` de `transferencia_cuentas_propias`
   sin necesitar la respuesta de Laura.

## Conclusión de la investigación (cerrada 2026-08-19)

🔴 **Ni el PDF ni el Excel nativo de Galicia traen CBU/CVU/cuenta destino para
`TRANSF. CTAS PROPIAS`.** Verificado contra el archivo real de junio 2026
(`privado/extractos/.../Banco Cta - Cte/Galicia/06-2026.xlsx` y `.pdf`), las 11 filas del literal
(§14 de `02-formato-galicia.md`):

- **Fila cruda del Excel** (`.xlsx`, hoja `Movimientos`; columnas `Leyendas Adicionales 1-4`).
  Estructura real, con los valores propios del cliente **redactados** (no son datos sintéticos
  del seed — son el material real del piloto, y no viajan a un documento del repo):
  ```
  ["<fecha>","Transf. Ctas Propias","",0,<importe>,
   "000907 - Transferencias","917312 - TRANSF. CTAS PROPIAS","","","",
   "<razón social del cliente>","<CUIT del cliente>","VARIOS","BANCO DE GALICIA Y BUENOS AIRES SAU",
   "Imputado",<saldo>]
  ```
  `Leyendas Adicionales 1` = razón social del propio cliente, `2` = su propio CUIT, `3` =
  `"VARIOS"` (genérico), `4` = nombre del banco (genérico) — ningún campo es una cuenta ni un
  CBU/CVU. Las 11 filas del literal tienen la misma forma.
- **Comparación de control, mismo archivo:** las filas de `Pago Con Transferencia` usan el MISMO
  layout (`Leyendas Adicionales 3` y `4`) y ahí sí traen un CBU real de 22 dígitos (valor
  redactado, mismo motivo). O sea: el banco **puede** publicar CBU en esas columnas — para
  `TRANSF. CTAS PROPIAS` específicamente, no lo hace.
- **PDF, mismas 11 filas** (`pdftotext -layout`): misma razón social (truncada a 20 caracteres,
  perdiendo la forma societaria final) y mismo CUIT — el Excel solo agrega lo que el PDF trunca.
  Cero dato de cuenta destino en ninguno de los dos formatos.

**Esta vía no alcanza.** Ni PDF ni Excel identifican CUÁL de las cuentas propias del cliente es
la contraparte de cada transferencia — solo confirman que es "cuentas propias" (mismo CUIT que
el titular). La pregunta de dirección para `transferencia_cuentas_propias`
(`catalogo.ts` — `pendienteDeLaura`) **sigue pendiente de Laura**; no se resuelve con el material
disponible hoy.

El tamaño del problema descrito abajo (fusión PDF+Excel como cambio arquitectónico) queda igual:
no hay evidencia que lo justifique para este caso puntual, y sigue sin diseñarse.

## Hallazgo aparte: la evidencia de `lado: 'ambos'` en `catalogo.ts:437` no mide dirección

> No relacionado con la conclusión de arriba — se anota acá porque salió a la luz investigando el
> mismo archivo. **No tocar el catálogo por esto todavía.**

`transferencia_cuentas_propias` en `packages/contabilidad/src/nucleo/catalogo.ts` (línea ~437)
cita como evidencia:

```
porLiteral: [{ literal: 'TRANSF. CTAS PROPIAS', movimientos: 11, lado: 'ambos' }],
```

con fuente `docs/diseno/02-formato-galicia.md §14`. Verificado contra esa sección: **§14 es una
lista de frecuencia de literales** (`TRANSF. CTAS PROPIAS (11)`), no mide lado. No hay medición
de "debe" vs "haber" detrás del `'ambos'` citado.

Y el único período muestreado hasta ahora (Galicia, 06/2026, el mismo `.xlsx` inspeccionado
arriba) arma la contradicción: **las 11 filas son 100 % crédito** (`Débitos = 0`, `Créditos > 0`
en las 11) — ningún débito. Un solo mes no alcanza para confirmar ni refutar "ambos lados" en
general (podría ser que el cliente solo recibió, nunca envió, en junio) — pero tampoco hay
evidencia que hoy sostenga `'ambos'` tal como está escrito.

**Antes de tocar el catálogo:** confirmar con más períodos (si hay extractos de otros meses en
`privado/extractos/`) o con la respuesta de Laura — no cambiar `lado: 'ambos'` a partir de un
solo mes.

## El tamaño del problema si esto avanza a diseño real

Si la investigación confirma que el Excel nativo trae un dato que el PDF no tiene (o viceversa,
en otro sentido), esto es un **cambio arquitectónico en Módulo 1**, no un ajuste chico: hoy
`ExtractoBancarioSource` (el contrato de ingesta, `packages/ingesta`) asume **una fuente por
banco** — el PDF. Pasar a dos fuentes complementarias por banco exige definir:

- Lógica de fusión entre las dos fuentes (¿el Excel enriquece filas que el PDF ya trajo, o es
  una fuente independiente que hay que reconciliar?).
- Manejo de conflicto entre fuentes (¿qué pasa si el PDF y el Excel discrepan en un mismo
  movimiento — monto, fecha, glosa?).
- Probablemente una decisión de ingesta nueva (mismo tipo de disparador que ya usó `0021` para
  Capa C: "esto es un paso propio, con su propia predicción falsable").

**Nada de esto está diseñado.** Es solo el tamaño identificado del problema, para que si la
investigación de los tres puntos de arriba confirma que vale la pena, la próxima sesión sepa
que entra directo en CLAUDE.md §3.2 (modo plan obligatorio, disparador (c): "modifica un
adaptador que ya corre contra datos de un cliente").

## Explícito: no es la cotización BNA

Este backlog es un frente **completamente independiente** del plan de `12-cotizacion-bna-plan.md`.
No comparten código, no comparten módulo (uno es Módulo 1 / ingesta; el otro es una integración
externa nueva para Módulo 2), y no hay orden de precedencia entre los dos — pueden retomarse en
cualquier orden, o en paralelo, sin conflicto.
