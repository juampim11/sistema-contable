# AGENTS.md — Instrucciones para agentes (Codex y compatibles) — `<NOMBRE_PROYECTO>`

> Puntero fino. La fuente de verdad vive en `docs/` y en `agents/personas/`. Claude Code usa
> `CLAUDE.md`, que apunta a los mismos documentos. Ambos se mantienen sincronizados en lo operativo;
> el contenido de dominio **no** se duplica acá.

## 0. Antes de tocar nada

1. **Base de arquitectura (obligatoria antes de escribir código):**
   `docs/arquitectura/ADR-0000-stack-infra.md` (stack, tres abstracciones, portabilidad),
   `ADR-0001-tenancy.md` (multi-tenancy jerárquica y RLS) y `ADR-0002-seguridad.md` (niveles de datos y
   reglas verificables). **Ningún cambio puede contradecirlos.**
2. Leé `docs/devops/01-entornos.md`, `02-sdlc-git-flow.md` y `03-reglas-desarrollo-optimizado.md`.
3. Leé la última entrada de `HANDOFF.md` para conocer el estado actual.
3. Para trabajar en un dominio específico, **adoptá la persona** correspondiente leyendo
   `agents/personas/<persona>.md`. Las personas son neutrales a la herramienta; las mismas que Claude
   Code expone como sub-agentes.

## 1. Reglas duras (idénticas a CLAUDE.md)

Ver `CLAUDE.md` §1 (`<REGLA_DURA_1..4>` + sin secretos en el repo + §1.6 guardrails de los agentes
fiscales/contables + §1.7 asistido-no-automático y aislamiento entre clientes). **No** reescribir acá.

> **Las dos que esta herramienta tiene que tener presentes en cada respuesta de dominio**, porque son las
> que se rompen sin darse cuenta:
>
> 1. **Nada de normativa de memoria.** Los agentes fiscales y contables responden **solo** desde
>    `knowledge/`, con **cita** (norma o RT + artículo/inciso + archivo de origen) y **fecha de
>    verificación de vigencia**. **Nunca** un número de norma o de RT inventado. Si falta la fuente:
>    **"no tengo esa fuente cargada"**. Cierre obligatorio con **"Validar con profesional matriculado"**
>    cuando el output tenga implicancia legal, fiscal o contable. Hoy `knowledge/` está **vacío**: que un
>    agente diga "no tengo esa fuente cargada" es el guardrail funcionando, no una falla a compensar.
> 2. **Un cliente puede tener VARIAS jurisdicciones activas a la vez** (Convenio Multilateral). No existe
>    "la jurisdicción activa" del sistema. Una respuesta de IIBB sin jurisdicción identificada es
>    inválida, y **nunca** se extrapola de una provincia a otra. Ver
>    `knowledge/JURISDICCIONES-ACTIVAS.md`.

## 2. Convenciones técnicas

Idénticas a `CLAUDE.md` §2 (TypeScript estricto + Zod, importes nunca como `number`, dominio en español,
Conventional Commits, una tarea por rama, migraciones `drizzle-kit` inmutables en SQL plano). Ver
`CLAUDE.md` para el detalle; **no** reescribir acá.

> **Las tres que esta herramienta tiene que tener presentes al tocar el esquema o la capa de datos:**
>
> 1. **Toda tabla de dominio nueva lleva los SIETE renglones** de `ADR-0001` §5 en la **misma**
>    migración: `cliente_id not null references tenant_node(id)`, índice, trigger
>    `app.exigir_nodo_cliente`, `enable` **y** `force row level security`, policy de `select`, policy de
>    escritura con `using` **y** `with check`, y el `grant` a `app_request`. Una tabla con `cliente_id`
>    sin RLS forzada es una fuga de datos entre clientes del estudio.
> 2. **El predicado se escribe exactamente `cliente_id in (select app.accessible_tenant_ids())`.**
>    `exists (select 1 from app.accessible_tenant_ids())` se lee igual, pasa los tests ingenuos y
>    significa "el usuario tiene acceso a algo": abre la tabla a **cualquier** usuario del SaaS. Y nunca
>    un `or … is null` ni un `coalesce` que abra el predicado (`ADR-0002` R4/R5, hallazgo H-4).
> 3. **Unicidades siempre por cliente** (`unique (cliente_id, …)`), nunca globales sobre un
>    identificador de tercero: un `unique(cuit)` global convierte el error de unicidad en un **oráculo**
>    que revela que ese CUIT ya es cliente de otro estudio (`ADR-0002` H-10).
>
> Y la regla de oro operativa: **el uuid del registro y el código de error alcanzan para depurar; el
> extracto no.** Nada de importes, CUIT, CBU ni descripciones de movimiento en un log (`ADR-0002` §D).

**Puntos de entrada obligatorios (ver `CLAUDE.md` §2.1, no se reescriben acá):** `conUsuario()` para
todo acceso a datos de un cliente; `conJob()` solo con un motivo de su unión cerrada; el `logger` de
`shared/observabilidad` (nada de `console.*`); `leerConAuditoria()` para todo lo N2-R/N3; y el generador
sintético para cualquier dato de desarrollo o test.

**El gate es `pnpm verificar`** (typecheck estricto + 72 tests). Cuatro cosas lo ponen rojo sin que nadie
tenga que notarlas en la revisión: una tabla con `cliente_id` sin RLS forzada, una columna sin clasificar
en el registro, un `console.*` o un `Pool` fuera de `packages/data/src/db/`, y una FK entre tablas de
dominio sin la columna de tenant.

## 3. El equipo (personas en `agents/personas/`)

**Roster completo, guardrails y matriz de convocatoria: `agents/README.md`** (índice único, misma fuente
para Codex y Claude Code — no se re-lista acá para que no diverjan). El nombre de cada persona es el
mismo en las dos herramientas (= filename en `agents/personas/`).

Hoy el roster son **23 personas**: 3 genéricas (`code-reviewer`, `documentador`, `tester`), 8 de
dominio (`contador-dominio`, `fiscal-nacional-iva-ganancias`,
`fiscal-ingresos-brutos-convenio-multilateral`, `integraciones-afip`, `motor-conciliacion-contable`,
`plan-cuentas-multicliente`, `balances-normas-tecnicas`, `seguridad-datos-financieros`) y 12 técnicas
(`product-owner`, `analista-funcional`, `arquitecto-software`, `tech-lead`, `ux-designer`,
`backend-dev`, `frontend-dev`, `dba-data`, `devops`, `qa-funcional`, `qa-automation`,
`security-engineer`).

🔴 **La delegación no es opcional: es la forma de trabajo por defecto del repo.** La matriz de
`tipo de tarea → agentes que se convocan SIEMPRE` está en **`CLAUDE.md` §3.1**, y vale igual acá — es
el mismo procedimiento para las dos herramientas. Dos puntos que se cobran caro si se saltean:

- **Toda migración, tabla o columna nueva** convoca a `dba-data` + `security-engineer` +
  `seguridad-datos-financieros`. Los tres.
- **`security-engineer` y `seguridad-datos-financieros` van juntos**, no uno en lugar del otro: el
  primero mira la superficie técnica, el segundo trae el criterio de qué dato es sensible en este
  negocio. El Módulo 1 se construyó sin ninguno de los dos y la auditoría posterior encontró un bug
  funcional que ningún test veía.

**Base de conocimiento:** los agentes fiscales y contables leen **exclusivamente** de `knowledge/`.
Convenciones en `knowledge/README.md`; qué cargar primero y de dónde en
`docs/agents/guia-carga-conocimiento.md`.

## 4. Handoff (protocolo transparente)

Agregá una entrada en `HANDOFF.md` apenas se cierra el DoD de una tarea o decisión. Claude Code lee la
misma bitácora y retoma. Regla de oro: **lo que no está escrito en `HANDOFF.md` o en los docs, no
existe para la otra herramienta.**

## 5. Convocatoria de sub-agentes en Codex (protocolo)

Codex **no auto-descubre** los sub-agentes de `.claude/agents/`. Para trabajar como el mismo equipo,
**adopta personas en secuencia**:

1. Leé el archivo `agents/personas/<persona>.md` **completo**.
2. Anunciá el cambio de sombrero, p. ej. `=== [Code Reviewer] ===`, y respondé **solo** desde ese rol
   y sus límites.
3. Al terminar, cerrá el rol: `=== [fin Code Reviewer] ===`.
4. Toda conclusión queda **escrita** (en la doc o en `HANDOFF.md`): lo que no está escrito no existe
   para Claude Code.

🔴 **El banner `=== [Persona] ===` es la convocatoria estructural de Codex** — el equivalente a la
tarea bloqueante `addBlockedBy` de `CLAUDE.md` §3.1 punto 6. Si el banner no aparece en la transcripción
**antes** del cambio de código, la convocatoria no ocurrió, sin importar qué diga el resumen final.
