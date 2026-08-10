---
name: nacional-readme
description: Índice de la capa nacional (AFIP/ARCA) - IVA, Ganancias y SIRE. Qué va en cada subcarpeta y de dónde se saca.
nivel: nacional
sources_status: esqueleto-sin-contenido
compilado: 2026-08-09
---

# Capa nacional — AFIP/ARCA

> **Vacío.** Ver `docs/agents/guia-carga-conocimiento.md` para el orden de carga; registrar cada
> descarga en `knowledge/_FUENTES.md`.

Aplica **igual a todos los clientes del estudio**, sin importar la provincia. Es la capa que más rinde
cargar primero: sirve para el 100 % de la cartera.

## Qué va acá

| Subcarpeta | Contenido |
|---|---|
| `iva/` | Impuesto al Valor Agregado: hecho imponible, débito y crédito fiscal, requisitos de cómputo, **prorrateo** con operaciones exentas/no gravadas, regímenes de retención y percepción, saldos técnicos vs. de libre disponibilidad, posición mensual. |
| `ganancias/` | Impuesto a las Ganancias: **personas humanas** (categorías de renta, deducciones personales, escala) y **sociedades** (determinación del resultado impositivo, ajustes al resultado contable, alícuota, anticipos). |
| `sire/` | Régimen de retenciones electrónicas: qué se informa, con qué formato y periodicidad, y su relación con las retenciones de IVA y Ganancias. |

Cuando se relevan las **Resoluciones Técnicas de la FACPCE**, van en una subcarpeta de este nivel
(`rt-facpce/`, creada al cargar el primer archivo). Ojo con la convención 5 de `knowledge/README.md`: la
RT se emite a nivel nacional pero **rige donde el Consejo Profesional local la adoptó**.

## Denominación del organismo

`[A VERIFICAR]` El organismo recaudador nacional pasó de denominarse **AFIP** a **ARCA**. La
denominación exacta vigente, las URLs de los portales y los nombres de los servicios se **verifican
contra la fuente oficial** antes de escribirlos en un archivo o en código — la documentación pública
convive con las dos denominaciones. No asumir de memoria. Ver `agents/personas/integraciones-afip.md`.

## De dónde se saca

- **Portal oficial del organismo recaudador nacional** — normativa, micrositios por impuesto,
  documentación de webservices, y los valores vigentes (deducciones, mínimos de retención).
- **Portal de normativa nacional / InfoLeg** (`infoleg.gob.ar`, `argentina.gob.ar/normativa`) — textos
  actualizados de leyes y decretos, con las modificaciones incorporadas.
- **Boletín Oficial de la República Argentina** (`boletinoficial.gob.ar`) — para confirmar la última
  modificación puntual y la fecha de vigencia de una norma.

⚠️ **Lo que más rápido queda viejo acá:** los importes de deducciones personales y la escala de
Ganancias, y los mínimos no sujetos a retención. Cargar el **período fiscal** que se necesita y anotar
la fecha de verificación; no reusar el archivo del año anterior sin revisarlo.
