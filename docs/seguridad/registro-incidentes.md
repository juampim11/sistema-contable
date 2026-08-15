# Registro de incidentes de seguridad

> **Procedimiento completo: `docs/arquitectura/ADR-0002-seguridad.md` §E.4.** Este archivo es la
> bitácora, no el procedimiento.
>
> **Orden no negociable: contener primero, entender después.** Rotar o revocar en el minuto uno; no se
> investiga con el secreto vivo. Si es una credencial fiscal, la revocación puede requerir una acción
> **del cliente** ante el organismo recaudador: contactarlo es parte del paso 1.

## Incidentes

| # | Fecha | Qué se filtró / qué pasó | Ventana de exposición | Alcance (clientes) | ¿Hay evidencia de uso? | Acciones y horarios | Control que impide la repetición | Cerrado |
|---|---|---|---|---|---|---|---|---|
| **1** | 2026-08-15 | **Vulnerabilidad de aislamiento — exposición NO confirmada.** Escalada de privilegios por shadowing de `pg_temp`: 6 de las 8 funciones de `app` leían relaciones sin calificar el esquema, y `pg_temp` se busca primero aunque no esté en el `search_path`. Con la credencial ordinaria de la aplicación (sin superusuario ni `BYPASSRLS`) se anulaban `accessible_tenant_ids()` y `has_role_on()`, o sea **lectura y escritura sobre todos los tenants de la instancia**. Al caer `has_role_on`, **N2-R quedó al nivel de N2**. NO se expuso `credencial_fiscal.material_cifrado` (N3): su control es un grant por columna, que se evalúa antes que la RLS | **Desde `0001_tenancy.sql` (2026-08-10) hasta el fix (2026-08-15).** El defecto era fundacional: existió cada minuto de vida del esquema | 2 bases. `sistema_contable` (local, sintética). `sistema_contable_piloto`: los titulares reales bajo la excepción E-1, en tenants separados. *(Sin nombres, uuid ni identificadores en esta bitácora.)* «Es local» no baja la severidad: E-1 fija que el entorno local se trata como productivo a los efectos de los controles | **No se puede determinar** — y eso es un hallazgo, no un detalle (regla 2). `acceso_auditoria` se escribe **desde la aplicación** y el vector no pasa por la aplicación; Postgres no tiene triggers de `SELECT`, `pgaudit` está descartado (ADR-0000 §6) y `log_statement` está en el default. Lo que **sí** se verificó, antes y después del fix: `verificar_coherencia_path()` = 0 y cero membresías inesperadas en las dos bases ⇒ **no hay evidencia de escalada persistente** (≠ «no hubo acceso») | Encontrado por auditoría interna de un agente, revisando otra cosa. Reproducido 3 veces de forma independiente. Barrido de las 8 funciones. Verificación forense **antes** de parchear (el vector permitía una membresía real que habría sobrevivido al fix). `0015_search_path_pg_temp.sql` aplicada a local y piloto el 2026-08-15, hash verificado sin drift. PoC re-ejecutado post-fix por las dos vías | **R10 (reescrita) + R10 bis**, ADR-0002 §B.1. R10: toda función de `app`/`public` —`definer` **y** `invoker`— declara `search_path` **terminado en `pg_temp`**; se chequea el **último elemento** de `proconfig`, no su presencia. R10 bis: ningún rol de aplicación conserva `TEMPORARY`. La R10 anterior exigía «fija `search_path`» y **pasó verde con el bug adentro** los cinco días: las dos funciones vulnerables lo fijaban. Verificado por **mutación**: revertir `exigir_nodo_cliente` al patrón viejo pone el test rojo listándola por nombre | **SÍ** — 2026-08-15. Código aplicado y verificado en las dos bases (PoC bloqueado por las dos vías, por separado), regla numerada en el ADR con el porqué de su redacción, y test que discrimina probado en rojo |

## Reglas de esta bitácora

1. **Se escribe durante el incidente, no después.** La reconstrucción de memoria pierde justo lo que
   importa: los horarios.
2. **"¿Hay evidencia de uso?" se contesta con `acceso_auditoria`** y con los logs del organismo o del
   banco. Si la respuesta es "no sabemos", eso mismo se escribe — y es un hallazgo sobre la auditoría,
   no un detalle del incidente.
3. **Un incidente no se cierra con "hay que tener más cuidado".** Se cierra con un control concreto,
   expresado como una regla verificable de ADR-0002 §B, con su número. Si no se puede expresar así, el
   incidente sigue abierto.
4. **Un secreto commiteado se considera público para siempre.** Se rota; reescribir el historial es
   opcional y posterior. Vale igual si el repo es privado.
5. **Sobre el deber legal de notificar** (a quién, en qué plazo): **no tengo esa fuente cargada**
   (ADR-0002 §G, G-3). Lo que sí se hace siempre es notificar al cliente afectado y al titular del
   estudio, por deber profesional y contractual. Ningún plazo legal se afirma acá.
