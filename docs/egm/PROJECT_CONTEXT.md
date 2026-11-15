# CardDex — Contexto del Elefante (EGM)
**Estado:** registro de contexto, no especificación aprobada
**Fecha:** 2026-11-15
**Repositorio:** https://github.com/e27182Gatio/carddex
**Proyecto:** https://e27182gatio.github.io/carddex/

## Objetivo y usuarios
Aplicación gratuita para escanear cartas físicas Pokémon TCG desde la cámara de Android, reconocer el ejemplar correcto, revisar la coincidencia y guardarlo en una colección individual; poder exportar CSV/JSON. La interfaz debe ser rápida, sin publicidad y adecuada para registrar muchas cartas. Amigos que abran el mismo enlace deben usar sus propias colecciones locales; no hay cuentas ni sincronización remota actualmente.

## Decisiones que nunca deben perderse
1. No agregar cartas al inventario automáticamente a partir de una lectura dudosa: el usuario confirma.
2. No romper ni migrar innecesariamente el almacenamiento actual (`localStorage`, clave `carddex.v1`).
3. Sin servidor obligatorio, suscripción ni API de pago para la ruta de escaneo normal.
4. No subir fotografías a servicios externos por defecto; Claude Vision es opcional, requiere consentimiento y clave propia.
5. Conservar captura manual, carga desde archivo, exportación CSV, respaldo JSON y las variantes (normal, holo, reverse holo) seleccionables.
6. Evitar duplicados accidentales producidos por la misma carta inmóvil; **eso no significa** impedir que una persona registre dos copias físicas iguales.
7. Debe funcionar como web/PWA sobre HTTPS en GitHub Pages, especialmente en Chrome de Android.
8. Las modificaciones van por fases, priorizando corrección y velocidad frente a estética.

## Arquitectura existente (verificar siempre frente al código actual)
- `index.html` y `js/app.js`: aplicación web y navegación hash.
- `js/views/scan.js`: cámara, monitor, recorte, resultados e historial temporal.
- `js/card-detect.js`: detección aproximada de cuatro bordes, huellas visuales y movimiento; **no** es un detector robusto de perspectiva.
- `js/ocr.js`: Tesseract.js local, lectura de nombre y número; archivo en `vendor/`.
- `js/identify.js`, `js/api.js`, `js/match.js`: candidatos, llamadas a TCGdex, clasificación de coincidencias.
- `js/ui.js`: fichas con confirmación y botón de agregado.
- `js/store.js`: colección local, validación de datos, configuración y respaldos.
- `js/views/collection.js`: inventario, cantidades y exportación CSV.
- `sw.js`: caché de PWA y política de actualización.
- `tests/card-detect.test.js`: pruebas sintéticas del detector.

## Estado de las fases al registrar este documento
- **Fase 1 (código V4 implementado):** intentar detectar automáticamente cartas rectangulares, mantener cámara abierta e incluir historial de hasta 12 coincidencias no guardadas. Se probó con imágenes sintéticas; **no hay evidencia de que funcione con distintas cartas físicas ni de que Pages esté actualizado en el dispositivo**.
- **Fase 2 (pendiente):** medir y mejorar latencia/precisión del OCR, búsqueda y confirmación; diseñar antes de codificar.
- **Fase 3 (pendiente):** bandeja persistente durante una sesión y guardado por lotes con validación humana.
- **Fase 4 (pendiente):** álbum visual, estadísticas e historial de precios.

## Problemas experimentados
- El usuario reportó errores de reconocimiento y lentitud.
- La detección automática previa (V3) no disparaba de forma consistente en el teléfono.
- V4 se desarrolló para rectángulos aproximadamente frontales, sin pruebas reales documentadas ni presupuesto de latencia.
- Falsos positivos por texturas, cartas parcialmente fuera de marco, reflejos, inclinación y cartas similares siguen siendo riesgos.
- Un hash perceptual puede confundir cartas de aspecto parecido; no es un identificador único.

## Política de entrega EGM
1. Elefante documenta problema, alternativas, plan y decisiones con referencias exactas.
2. **Sin cambios de producción** hasta revisión independiente con un Goldfish que no vea esta conversación, resolución de hallazgos y aprobación humana.
3. Goldfish realiza al menos revisión de comprensión, revisión crítica/adversarial y verificación de preparación de implementación.
4. Tras aprobar: cambios en rama/PR, pruebas unitarias, pruebas de cámara reales y verificación en GitHub Pages.
5. Distinguir siempre: código guardado ≠ desplegado ≠ validado en dispositivo.

## Preguntas abiertas
- ¿Qué cartas, idioma, expansiones y condiciones de iluminación servirán como banco de pruebas?
- ¿Qué métricas cuantitativas de precisión y tiempo son aceptables?
- ¿La app debe intentar capturar solo si todos los bordes son visibles o permitir recortes parciales?
- ¿Cómo se gestionan varias copias idénticas durante un escaneo continuo?
- ¿Cómo actualizar el service worker sin perder datos locales?
