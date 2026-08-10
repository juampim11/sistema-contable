# CLAUDE.md — Instrucciones para Claude Code (`<NOMBRE_PROYECTO>`)

> Puntero fino. La fuente de verdad vive en `docs/` y en las personas de `agents/personas/`. Codex usa
> `AGENTS.md`, que apunta a los mismos documentos. Mantener ambos sincronizados en lo operativo y **no**
> duplicar contenido de dominio acá.

## 0. Antes de tocar nada

1. Leé `docs/devops/01-entornos.md` (entornos), `02-sdlc-git-flow.md` (cómo se trabaja cada cambio) y
   `03-reglas-desarrollo-optimizado.md` (presupuesto de recursos y buenas prácticas).
2. Leé la última entrada de `HANDOFF.md` (o `<BITACORA>`) para saber en qué estado quedó el trabajo.
3. Si vas a trabajar en un dominio específico, **adoptá la persona** correspondiente en
   `agents/personas/<persona>.md` (o usá el subagente en `.claude/agents/`).

## 1. Reglas duras (no negociables)

> Base de arquitectura: **`docs/arquitectura/ADR-0000-stack-infra.md`** (stack y portabilidad),
> **`ADR-0001-tenancy.md`** (multi-tenancy y RLS), **`ADR-0002-seguridad.md`** (niveles de datos y
> reglas verificables). Ningún cambio puede contradecirlos.

1. **Agnóstico de proveedor:** ningún servicio de negocio llama directo a un SDK propietario. Todo pasa
   por las tres abstracciones propias — datos (Drizzle sobre Postgres), auth (`AuthProvider`),
   almacenamiento (`ObjectStorage` S3-compatible). Ver ADR-0000 §3.
2. **Aislamiento multi-tenant, verificado y no confiado:** toda tabla con datos de un cliente lleva
   `cliente_id`, `enable` **y** `force row level security`, y el predicado
   `cliente_id in (select app.accessible_tenant_ids())`. Ningún acceso sin pasar por
   `conUsuario()`. Unicidades **siempre** por cliente, nunca globales. Los siete renglones obligatorios
   están en ADR-0001 §5 y las reglas verificables en ADR-0002 §B.
3. **Lógica de negocio determinística; sin LLM en el núcleo.** Un modelo puede sugerir; lo que produce
   una propuesta con su score y su evidencia es código determinístico y testeado.
4. **Datos financieros de terceros: nunca en logs, nunca en un entorno de prueba, nunca a un servicio
   externo sin decisión registrada** (ADR-0002 §A y §D). El uuid del registro y el código de error
   alcanzan para depurar; el extracto no.
5. **Nada de secretos en el repo.** Todo por variables de entorno (`.env.example`).
6. **Los agentes fiscales y contables nunca inventan normativa.** `contador-dominio`,
   `fiscal-nacional-iva-ganancias`, `fiscal-ingresos-brutos-convenio-multilateral`,
   `integraciones-afip`, `balances-normas-tecnicas` y —en lo normativo— `seguridad-datos-financieros`
   responden **solo** con base en `knowledge/`, **citan la fuente** en cada afirmación (norma o RT +
   artículo/inciso + archivo de origen), **nunca inventan un número de norma ni de RT**, **marcan
   vigencia y fecha de verificación** de cada dato fiscal (topes y alícuotas cambian seguido) y
   **cierran con "Validar con profesional matriculado"** cuando el output tenga implicancia legal,
   fiscal o contable. Si falta la fuente: **"no tengo esa fuente cargada"**, nunca un supuesto.
   Ver `knowledge/README.md` y `docs/agents/guia-carga-conocimiento.md`.
7. **El sistema es ASISTIDO, no automático.** El motor de conciliación **propone** asientos con su
   evidencia y los deja en cola de revisión del contador; **nunca registra por su cuenta** (ver
   `agents/personas/motor-conciliacion-contable.md`). Y **un cliente nunca ve el dato de otro**: el
   aislamiento y el secreto fiscal son requisitos de diseño, no un detalle de implementación (ver
   `agents/personas/seguridad-datos-financieros.md`).

## 2. Convenciones técnicas

- **TypeScript estricto** de punta a punta; validación de límites con **Zod**. Stack completo y monorepo:
  ADR-0000 §2.
- **Ningún importe como `number` de JavaScript.** En base `numeric`; en TS `string` + utilidad de
  dominio. Zona horaria explícita, no la del host (ADR-0000 §2.3).
- Dominio en **español** (`cliente`, `asiento`, `movimiento`, `jurisdiccion`); plomería técnica genérica
  en inglés (`AuthProvider`, `ObjectStorage`). Comentarios en **español**.
- Commits: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Una tarea = una rama (`feat/<slug>`). PRs chicos y revisables.
- Migraciones: **`drizzle-kit`**, SQL plano en `packages/data/migrations/NNNN_*.sql`. Nunca editar una ya
  aplicada; crear la siguiente con prefijo incremental. Corren con el **dueño del esquema**, nunca con
  `app_request`. Con Drizzle los tipos se infieren del esquema TS (no hay paso de "generar tipos").
- **Toda tabla de dominio nueva se crea con los siete renglones** de ADR-0001 §5 en la **misma**
  migración (y los **cuatro extra** del pie de `0002_endurecimiento.sql` si tiene columnas N2-R/N3).
  Una tabla con `cliente_id` sin RLS forzada es una fuga de datos entre clientes.
- **Toda columna nueva se clasifica** en `packages/shared/src/seguridad/clasificacion-campos.ts`, en la
  misma tarea. Sin entrada en el registro, el gate se pone rojo — no hay "sin clasificar".
- **Arranque local y gate:**
  ```bash
  pnpm db:up && pnpm db:migrate && pnpm db:setup   # infra + esquema + roles
  pnpm db:seed                                     # datos SINTÉTICOS (nunca reales)
  pnpm verificar                                   # typecheck estricto + 72 tests (gate)
  ```
  Detalle del runbook: ADR-0000 §4.1.

## 2.1. Puntos de entrada obligatorios (no hay alternativa "más rápida")

| Para… | Se usa | Nunca |
|---|---|---|
| Leer o escribir datos de un cliente | `conUsuario(usuarioId, fn)` de `packages/data` | Un `Pool`/`Client` propio, ni `app_job` |
| Un trabajo de sistema | `conJob(motivo, fn)` — el motivo es una **unión cerrada** | Agregarle un motivo nuevo sin ADR. `'ingesta_bancaria'` **no está** y es a propósito |
| Loguear | `logger` de `@sistema-contable/shared/observabilidad` | `console.*` (el gate lo rechaza) |
| Leer algo N2-R/N3 | `leerConAuditoria(tx, pedido, fn)` | Leerlo directo: no deja rastro |
| Datos para desarrollo o tests | el generador de `packages/data/src/seed/sintetico.ts` | Un dump de producción, ni un CUIT real |
- **Flujo completo** (ramas → entornos → deploy → versionado): `docs/devops/02-sdlc-git-flow.md`.
  Versionado en `CHANGELOG.md`.

## 3. Sub-agentes disponibles (`.claude/agents/`)

Roster y protocolo portable: `agents/README.md`. Los nombres del sub-agente y de su persona son el
mismo (= filename en `agents/personas/`).

**Genéricos (del template):**

| Sub-agente | Para qué |
|---|---|
| `code-reviewer` | Revisa el diff: bugs de correctitud + simplificación/reuso/eficiencia |
| `documentador` | Docs, README, CHANGELOG y bitácora sincronizados con el código |
| `tester` | Verificación adversarial y estrategia de test (intenta romper antes del "Done") |

**De dominio (perfiles super-senior):**

| Sub-agente | Para qué |
|---|---|
| `contador-dominio` | Plan de cuentas, criterios de asientos, cierre de balance, RT de FACPCE — define **cómo se registra** |
| `fiscal-nacional-iva-ganancias` | IVA (débito/crédito, prorrateo, retenciones y percepciones) y Ganancias (personas humanas y sociedades), incluido SIRE |
| `fiscal-ingresos-brutos-convenio-multilateral` | IIBB unilateral y Convenio Multilateral (coeficiente unificado, regímenes especiales, SIFERE) — separado del fiscal nacional por la complejidad del reparto interjurisdiccional |
| `integraciones-afip` | Rieles técnicos de AFIP/ARCA (webservices, certificados, SIRE, padrón) y seguimiento de cambios normativos |
| `motor-conciliacion-contable` | Motor que clasifica movimientos bancarios contra el plan de cuentas y **propone** asientos a revisión del contador (reusa el motor de `trazabilidad-obra-gas`) |
| `plan-cuentas-multicliente` | Versiona por cliente los atributos que cambian su tratamiento (condición ante IVA, forma societaria, jurisdicciones de IIBB, plan propio) |
| `balances-normas-tecnicas` | Estados contables según RT de FACPCE, incluida la variante RT 41 para PyMEs — define **cómo se presenta** |
| `seguridad-datos-financieros` | Secreto fiscal y datos bancarios/tributarios de terceros: aislamiento entre clientes, roles, credenciales, trazabilidad — **obligatorio** ante datos de clientes, dinero, permisos o aislamiento |

**Matriz de convocatoria y guardrails detallados: `agents/README.md`.** Los agentes fiscales y contables
leen **exclusivamente** de `knowledge/` (regla dura §1.6). Qué cargar primero y de dónde:
`docs/agents/guia-carga-conocimiento.md`.

> **Pendiente:** el roster técnico de ingeniería (arquitecto, backend, frontend, dba/data, devops, qa) se
> da de alta cuando arranque la construcción. **Ingesta bancaria** y **tenancy** son la etapa siguiente.

## 4. Handoff

Escribí una entrada en `HANDOFF.md` **apenas se cierra el DoD** de una tarea o decisión (no esperes al
final de la sesión). La otra herramienta (Codex) lee la misma bitácora y retoma. **Lo que no está
escrito en `HANDOFF.md` o en los docs, no existe para la otra herramienta.**
