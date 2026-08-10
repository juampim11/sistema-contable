# Sub-agentes portables — estructura y roster

> Estructura de sub-agentes **portable**: la misma fuente de verdad sirve para **Claude Code** y para
> **Codex** (u otro agente compatible con `AGENTS.md`), sin duplicar contenido.

## El modelo en una frase

**La fuente de verdad son las personas** (`agents/personas/*.md`): el rol completo, **neutral a la
herramienta**. Encima:

- **Claude Code** expone cada persona como sub-agente vía un **wrapper fino** en `.claude/agents/`
  (frontmatter `name` + `description` + un cuerpo que dice "Leé `agents/personas/<persona>.md`").
- **Codex** no auto-descubre `.claude/agents/`; en cambio **"adopta la persona"** leyendo el mismo
  `agents/personas/<persona>.md`, siguiendo el protocolo de `AGENTS.md`.

```
              agents/personas/<persona>.md   ← FUENTE DE VERDAD (rol completo, neutral)
                 ▲                       ▲
   "Leé la persona"                       "Adoptá la persona" (AGENTS.md)
                 │                       │
   .claude/agents/<x>.md            AGENTS.md
   (wrapper fino, Claude Code)      (protocolo de adopción, Codex)
```

**Regla de oro: un agente = un nombre.** El nombre del wrapper de Claude Code y el de la persona que
adopta Codex **son el mismo** (= el filename en `agents/personas/`).

## Contenido de esta carpeta

```
agents/
├── README.md                 ← este archivo (roster + cómo funciona + activación)
├── personas/                 ← FUENTE DE VERDAD (neutral, se lee en las dos herramientas)
│   ├── code-reviewer.md              ┐
│   ├── documentador.md               ├ genéricos (del template)
│   ├── tester.md                     ┘
│   ├── contador-dominio.md                              ┐
│   ├── fiscal-nacional-iva-ganancias.md                 │
│   ├── fiscal-ingresos-brutos-convenio-multilateral.md  │
│   ├── integraciones-afip.md                            ├ dominio (este producto)
│   ├── motor-conciliacion-contable.md                   │
│   ├── plan-cuentas-multicliente.md                     │
│   ├── balances-normas-tecnicas.md                      │
│   └── seguridad-datos-financieros.md                   ┘
└── wrappers-claude/          ← wrappers finos; se copian a .claude/agents/ (ya copiados)
    └── … un archivo por persona, con el MISMO nombre
```

**Estado de activación:** `.claude/agents/` ya existe con los **11** wrappers copiados (3 genéricos +
8 de dominio). Al agregar o editar un wrapper, volver a copiar (ver §Activación).

## Roster base (propósito general)

| Persona (nombre único) | Qué hace | Cuándo convocar |
|---|---|---|
| `code-reviewer` | Revisa el diff buscando bugs de correctitud y oportunidades de simplificación/eficiencia. | Antes de mergear cualquier cambio no trivial. |
| `documentador` | Mantiene docs, README, CHANGELOG y la bitácora sincronizados con el código. | Al cerrar una feature o decisión; cuando la doc quedó atrás. |
| `tester` | Diseña y ejercita pruebas; intenta **romper** el cambio antes del "Done". | Antes de cerrar toda tarea sensible, aunque el gate esté verde. |

> Estos 3 vienen del template y se mantienen. `PROXIMO-PROYECTO-barrios.md` queda como ejemplo del
> patrón, **no** como roster de este producto.

## Roster técnico de ingeniería

Se dio de alta **despues** de construir el Módulo 1, y esa demora tuvo un costo medible: el módulo se
escribió sin `security-engineer` ni `dba-data`, y la primera pasada de los dos —punto por punto contra
ADR-0001 §5 y ADR-0002— encontró un bug funcional que ningún test veía (dos identificadores vigentes
para la misma cuenta dejaban el extracto en `cuenta_ambigua` **de forma permanente**) y un tipo del
logger que había divergido de su propia fuente. Vale escrito acá porque es el argumento de por qué el
roster se convoca **antes** y no como revisión final.

| Persona (nombre único) | Qué hace | Cuándo convocar |
|---|---|---|
| `product-owner` | Prioriza, define el valor y el criterio de aceptación de negocio; dueño del backlog y del alcance. | Al abrir una etapa, al discutir alcance, o cuando hay que elegir qué NO se hace. |
| `analista-funcional` | Traduce la necesidad a requisitos verificables: flujos, reglas, casos borde, datos de entrada y salida. | Antes de diseñar, cuando el pedido está en lenguaje de negocio y no en condiciones. |
| `arquitecto-software` | Estructura del sistema, límites entre paquetes, y **todo lo que toca un ADR**. Custodia la portabilidad. | Ante un cambio estructural, una dependencia nueva, o algo que contradiga un ADR. |
| `tech-lead` | Coherencia del código entre piezas que hacen lo mismo, deuda técnica, orden de ejecución. | Cuando hay ≥2 implementaciones del mismo patrón (adaptadores, lectores), o antes de escalar una. |
| `ux-designer` | Flujo de la interfaz y del CLI: qué ve el operador, en qué orden, y qué hace ante un error. | Al definir una salida que lee una persona — incluidos los mensajes de error del CLI. |
| `backend-dev` | Implementa servicios, casos de uso y persistencia respetando los puntos de entrada obligatorios. | En toda construcción de servidor. |
| `frontend-dev` | Implementa la interfaz. | Cuando exista interfaz. |
| `dba-data` | Modelo de datos, migraciones, índices con una consulta real detrás, y los siete renglones de tenancy. | **Obligatorio** ante cualquier migración, tabla o columna nueva. |
| `devops` | Entornos, CI, hooks, secretos, despliegue y runbook. | Ante cambios de infraestructura, pipeline o arranque. |
| `qa-funcional` | Verifica contra el criterio de aceptación **del negocio**: ¿esto sirve para lo que se pidió? | Antes de dar por cerrada una entrega que alguien va a usar. |
| `qa-automation` | Diseña la suite y el gate, y verifica que **cada test discrimine** (prueba por mutación). | Al agregar cobertura, al elegir nivel de test, y **cuando el gate está verde e igual apareció un bug**. |
| `security-engineer` | Superficie técnica: autenticación, autorización, entradas, secretos, dependencias, logs. | Ante cualquier cambio que toque credenciales, permisos, entrada externa o salida de datos. |

> 🔴 **`security-engineer` y `seguridad-datos-financieros` se convocan JUNTOS, no en lugar del otro.**
> No se solapan: el primero pregunta *"¿por dónde se entra y por dónde sale?"* y el segundo *"¿qué dato
> es sensible en ESTE negocio y por qué?"*. Un revisor de seguridad genérico no sabe que la
> `descripcion` de un movimiento bancario puede contener el CUIT de un tercero que no es cliente del
> estudio — y esa es exactamente la clase de fuga que importa acá.

## Personas de dominio — producto para estudios contables

Ocho perfiles **super-senior**, dados de alta antes de escribir código. Cada uno tiene su rol completo en
`agents/personas/<nombre>.md`.

| Persona (nombre único) | Qué hace | Cuándo convocar |
|---|---|---|
| `contador-dominio` | Práctica contable argentina: **plan de cuentas**, criterios de asientos e imputación, **cierre de balance**, RT de FACPCE aplicables. Define **cómo se registra**. | Al diseñar el plan de cuentas, decidir qué asiento corresponde a un hecho, o el proceso de cierre. |
| `fiscal-nacional-iva-ganancias` | **IVA** (débito/crédito, prorrateo, retenciones y percepciones) y **Ganancias** (personas humanas y sociedades), incluido **SIRE**. | Ante cualquier consulta de tributación nacional o al diseñar un cálculo impositivo nacional. |
| `fiscal-ingresos-brutos-convenio-multilateral` | **IIBB unilateral** y **Convenio Multilateral**: coeficiente unificado, atribución de ingresos y gastos, regímenes especiales, **SIFERE**, retenciones por jurisdicción. | Ante cualquier consulta de IIBB o de reparto interjurisdiccional. |
| `integraciones-afip` | Rieles técnicos de **AFIP/ARCA**: webservices, certificados y credenciales, SIRE, padrón, homologación vs. producción; y **seguimiento de cambios normativos** con impacto técnico. | Al diseñar o revisar cualquier integración con el organismo recaudador. |
| `motor-conciliacion-contable` | Diseña el motor que clasifica **movimientos bancarios** contra el plan de cuentas y **PROPONE asientos** a revisión del contador. Adapta el motor de matching de `trazabilidad-obra-gas`. | Al diseñar reglas de clasificación, umbrales, evidencia de la propuesta, o el reuso del motor del gas. |
| `plan-cuentas-multicliente` | Versiona por cliente los atributos que cambian su tratamiento: condición ante IVA, forma societaria, **jurisdicciones de IIBB activas**, plan de cuentas propio. | Al modelar el cliente o cualquier cálculo que dependa de un atributo con vigencia. |
| `balances-normas-tecnicas` | Estados contables según **RT de FACPCE**, incluida la variante **RT 41** para PyMEs: estados, rubros, notas, ajuste por inflación. Define **cómo se presenta**. | Al definir la exposición, el mapeo plan de cuentas → rubro, o el encuadre del ente. |
| `seguridad-datos-financieros` | Especialización de un security-engineer para **secreto fiscal** y datos bancarios/tributarios de terceros: aislamiento entre clientes, roles, credenciales, logs, datos de prueba, trazabilidad. | **Obligatorio** ante cambios que toquen datos de clientes, dinero, permisos o aislamiento. |

### Guardrails de los agentes fiscales y contables (no negociables)

`contador-dominio`, `fiscal-nacional-iva-ganancias`,
`fiscal-ingresos-brutos-convenio-multilateral`, `integraciones-afip`, `balances-normas-tecnicas` y
—en lo normativo— `seguridad-datos-financieros`:

1. Responden **solo** con base en `knowledge/`. Si falta la fuente: **"no tengo esa fuente cargada"**.
2. **Citan la fuente** en cada afirmación (norma o RT + artículo/inciso + **archivo** de origen).
3. **Nunca inventan un número de norma**, de resolución, de RT ni de artículo.
4. **Marcan vigencia y fecha de verificación** de cada dato fiscal — topes y alícuotas cambian seguido.
5. **Cierran con "Validar con profesional matriculado"** cuando el output tenga implicancia legal, fiscal
   o contable.

Ver `knowledge/README.md` (convenciones), `knowledge/JURISDICCIONES-ACTIVAS.md` (un cliente puede tener
**varias** jurisdicciones a la vez) y `docs/agents/guia-carga-conocimiento.md` (qué cargar primero).

Los dos agentes de diseño (`motor-conciliacion-contable`, `plan-cuentas-multicliente`) no son
normativos; sus reglas duras propias son **"asistido, no automático"** (toda salida es una propuesta a
revisión del contador) y **"todo atributo versionado por vigencia"** (un recálculo histórico es
reproducible).

## Matriz de convocatoria

| Si la necesidad toca… | Convocar |
|---|---|
| Plan de cuentas, asientos, cierre de ejercicio | `contador-dominio` |
| IVA, Ganancias, retenciones nacionales, SIRE | `fiscal-nacional-iva-ganancias` |
| IIBB, coeficientes, jurisdicciones, SIFERE | `fiscal-ingresos-brutos-convenio-multilateral` |
| Webservices, certificados, padrón, cambio normativo con impacto técnico | `integraciones-afip` |
| Clasificar movimientos bancarios / proponer asientos | `motor-conciliacion-contable` (+ `contador-dominio`) |
| Modelo del cliente, atributos con vigencia, plan propio | `plan-cuentas-multicliente` (+ el agente de dominio que define el tratamiento) |
| Estados contables, exposición, RT, ajuste por inflación | `balances-normas-tecnicas` |
| **Datos de clientes, dinero, permisos, aislamiento** | `seguridad-datos-financieros` — **obligatorio** |
| Cualquier decisión con implicancia fiscal **y** contable | panel: `contador-dominio` + el fiscal que corresponda |
| Antes de mergear un cambio no trivial | `code-reviewer`; `tester` antes del "Done"; `documentador` al cerrar |
| **Una migración, una tabla o una columna nueva** | `dba-data` + `security-engineer` + `seguridad-datos-financieros` — **los tres, obligatorio** |
| Un cambio estructural o algo que roce un ADR | `arquitecto-software` (+ `tech-lead`) |
| ≥2 implementaciones del mismo patrón, o antes de escalar una | `tech-lead` |
| Cobertura nueva, o el gate verde con un bug adentro | `qa-automation` |
| Un mensaje o una salida que lee una persona | `ux-designer` |
| Alcance, prioridad, o qué NO se hace | `product-owner` (+ `analista-funcional` para las condiciones) |

> La matriz completa por **tipo de tarea**, con el orden de convocatoria y las reglas de cómo se
> convoca, vive en **`CLAUDE.md` §3.1**. Esta tabla es el índice; aquélla es el procedimiento.

## Pendiente de dar de alta

Nada del roster. Lo que sigue pendiente es **contenido**, no personas: la ingesta bancaria de los cinco
bancos que faltan y la carga de `knowledge/`.

## Activación

1. **Claude Code:** copiá `agents/wrappers-claude/*.md` a **`.claude/agents/`** (Claude Code
   auto-descubre esa carpeta). **Ya está hecho** para los 23 actuales; repetir al agregar o editar uno:
   `cp agents/wrappers-claude/*.md .claude/agents/`.
2. **Codex:** nada que copiar — `AGENTS.md` ya instruye adoptar personas desde `agents/personas/`.
3. `CLAUDE.md` §3 y este archivo tienen que listar **las mismas** personas (ver checklist abajo).

## Checklist de sincronía (al agregar o renombrar una persona)

Los **tres archivos por agente** + los **tres lugares donde se lista**:

- [ ] `agents/personas/<nombre>.md` — el rol completo (fuente de verdad).
- [ ] `agents/wrappers-claude/<nombre>.md` — wrapper con **el mismo nombre**, frontmatter
      `name: <nombre>` (igual al filename) + `description`.
- [ ] `.claude/agents/<nombre>.md` — copia del wrapper (`cp agents/wrappers-claude/*.md .claude/agents/`).
- [ ] La tabla de roster de **este archivo** (arriba) y la **matriz de convocatoria**.
- [ ] La tabla de `CLAUDE.md` §3.
- [ ] `AGENTS.md` §3 — no lista personas (apunta acá), pero verificar que el puntero siga siendo correcto.

Verificación rápida de que las tres capas están sincronizadas:

```bash
# mismos nombres en las tres carpetas, y frontmatter name == filename
ls agents/personas/ agents/wrappers-claude/ .claude/agents/
grep -H '^name:' .claude/agents/*.md
```
