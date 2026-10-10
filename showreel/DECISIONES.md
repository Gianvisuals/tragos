# DECISIONES — Showreel de motion design (8 s)

**Entregable:** `showreel.mp4`: 1920×1080, 30 fps, 240 fotogramas, H.264 + AAC estéreo, 8,000 s exactos.
**Regla del encargo:** todo es código. No usé modelos de imagen, vídeo ni audio, ni samples, imágenes, texturas o vídeos externos. Las únicas "materias primas" son las fuentes del sistema (Inter Display y DejaVu Sans Mono) y las matemáticas.

| Archivo | Qué hace |
|---|---|
| `reel.js` / `reel.html` | Motor visual: 8 escenas en Canvas2D + 2 shaders WebGL2, motion blur por acumulación y post-proceso |
| `render.mjs` | Abre Chromium sin ventana (headless) con Playwright, pinta cada fotograma y lo guarda como PNG |
| `music.mjs` | Sintetizador y mezclador escritos desde cero; genera el WAV |
| `build.sh` | Reproduce todo el proceso: música → fotogramas → MP4 |

---

## 1. La idea

Un showreel de verdad no enseña "efectos": enseña **criterio**. Por eso la pieza es una mini-clase de los principios de animación, encadenada sin cortes gratuitos. Cada escena hereda un elemento de la anterior (*match cut*), y cada principio aparece rotulado en el HUD como si fuera la ficha técnica del reel:

| t (s) | Escena | Qué demuestra | Cómo enlaza con la siguiente |
|---|---|---|---|
| 0–1 | **01 Squash & Stretch** | Pelota con física de parábola, *squash* al impacto, *stretch* proporcional a la velocidad, *onion skin* (rojo = fotogramas anteriores, lima = siguientes, la convención clásica de 2D), carta de espaciado con un punto por fotograma, gráfica de *timing* ease-in y suelo elástico que vibra (muelle amortiguado) | El segundo bote abre un barrido circular y la pelota salta a… |
| 1–1.9 | **02 Kinetic Type** | …la **O** de MOTION. Las letras emergen de su subrayado con escalonado de 45 ms; la segunda O es un anillo que se dibuja; en el tiempo 3 la palabra hace un *skew* de látigo (*overlapping action*); filas de marquesina en contrasentido | La pantalla se rompe en 10 lamas alternas |
| 1.9–3 | **03 Grid Systems** | 1.296 celdas, cada una una **superelipse** cuyo exponente se anima: 2 = círculo, 5 = cuadrado redondeado, 14 = cuadrado, 0,7 = astroide. Así un único parámetro continuo hace todas las transformaciones de forma. Ondas desde el centro y en diagonal; la cobertura de cada celda sobre una máscara de texto deletrea **GRID** en píxeles; barrido a lima | La rejilla entera… |
| 3–4 | **04 Anticipation** | …cae en espiral hacia un núcleo (interior primero, como un desagüe), con anillos sincronizados al redoble que acelera. Zoom y rotación lentos. A 3,875 s todo colapsa en un punto y hay **125 ms de silencio** total | El punto estalla en… |
| 4–5 | **05 3D · Shading** (drop) | Blob raymarcheado en GLSL: SDF con unión suave (`smin`), cromo iridiscente de película fina, Fresnel, AO, entorno de estudio procedural (softbox cenital, tiras roja y azul, contra lima). Latido con cada bombo, anticipación (se encoge) antes de explotar. Rótulos técnicos tipo plano | El blob revienta en… |
| 5–6 | **06 Particles** | 11.000 partículas que salen del blob, viajan por un campo de **ruido curl** (flujo sin divergencia, integrado de antemano a 120 Hz) y convergen en **FORM** con barrido de izquierda a derecha. Caos → forma | Corte a ritmo |
| 6–7 | **07 Rhythm & Edit** | Cuatro cortes a corchea: **FLUID** (shader de *domain warping*), **BUILD** (isometría con onda de alturas), **LOOP** (arcos orbitales que frenan tras un arranque brusco), **CODE ONLY** (glitch RGB y rebanadas, con el **propio código fuente del vídeo** desplazándose de fondo) | Golpe final |
| 7–8 | **08 Identity** | La pelota vuelve como logotipo (cierre en espejo con el inicio), *Claude* emerge de su máscara, filete, subtítulo tecleado con cursor y créditos de método: `240 FRAMES · 0 IMAGES · 0 SAMPLES · 100% CODE` | — |

**HUD persistente** (estética de reel de estudio): marcas de corte, firma, contador de escena, metrónomo que parpadea en cada tiempo, timecode SMPTE real por fotograma, etiqueta de escena que se teclea al entrar y barra de progreso con 16 marcas (una por tiempo). Da unidad a ocho estilos visuales distintos.

**Paleta cerrada de 5 colores**, usada en todas las escenas: tinta `#0C0C10`, papel `#F1ECE2`, bermellón `#FF4321`, cobalto `#2337FF`, lima `#D4FF3A`. El rojo es el color de la firma: la pelota, la O, el logo.

## 2. Decisiones técnicas clave

1. **120 BPM, porque 8 s son exactamente 4 compases.** Un tiempo son 15 fotogramas exactos y cada escena dura uno o dos tiempos. Música y vídeo comparten la misma línea de tiempo (`KICKS`, `ROLL` y `CUT` aparecen tanto en `reel.js` como en `music.mjs`). Los impactos, cortes, flashes y anillos caen sobre el bombo, el redoble o el golpe que les corresponde, porque se calcularon a partir del mismo dato y no se ajustaron a ojo.
2. **Motion blur real.** Cada fotograma es la media de **8 subfotogramas** con obturador de 180° (como una cámara de cine). La suma se hace en un FBO de coma flotante y en **espacio lineal**, para que las estelas brillantes conserven la energía. Cada subfotograma se desplaza además una fracción de píxel siguiendo una secuencia de Halton, lo que da antialiasing 8× gratis, también al shader 3D.
3. **La escena se elige con el tiempo del fotograma; la animación usa el del subfotograma.** Así el desenfoque nunca mezcla dos planos en un corte seco. Los cortes del montaje caen a corchea (7,5 fotogramas), así que los cuanticé al fotograma más cercano.
4. **Todo es función pura del tiempo.** `draw(t)` es determinista y no acumula estado, de modo que se puede renderizar cualquier fotograma suelto, en cualquier orden y en paralelo. La única simulación (las partículas) se precalcula a 120 Hz y se interpola.
5. **Curvas propias.** Las principales: una Bézier "firma" `(0.7, 0, 0.15, 1)` (arranque contenido y frenada muy larga) resuelta por bisección; un muelle amortiguado analítico para los rebotes de tamaño; un impulso amortiguado (`wobble`) para el suelo, el látigo del texto y la respiración del logo. No hay ni un `linear` en la animación principal.
6. **Post-proceso** en WebGL2: bloom por luminancia (solo en las escenas oscuras), aberración cromática radial con picos en cada impacto, viñeta y grano animado. La aberración aumenta al saturarse la señal, como en una óptica real que se fuerza.
7. **Vibración de cámara** con ruido Perlin que decae tras cada golpe; la más fuerte, en el drop.

## 3. La música (síntesis desde cero)

D menor, 120 BPM, progresión **Dm9 → B♭maj9 → (drop) B♭ → C → Dm → F(add9)**. Es la cadencia VI–VII–i–III: termina en el relativo mayor, así que suena a resolución luminosa justo cuando aparece el logo.

- **Instrumentos, todos sintetizados:**
  - Bombo: seno con barrido de tono y clic.
  - Palmada: tres ráfagas de ruido filtrado.
  - Caja.
  - Charles metálicos: 6 ondas cuadradas inarmónicas al estilo 808.
  - Bajo: seno + sierra filtrada.
  - Acordes: **supersierra** de 7 voces por nota, con polyBLEP antialias.
  - Arpegios y melodía: **cuerda pulsada Karplus–Strong**.
  - Efectos: risers de ruido, *bloops* FM y granos sinusoidales para las partículas.
- **El sonido sigue a la imagen:**
  - Cada bote de la pelota es un golpe con su nota.
  - Cada letra de MOTION es una nota ascendente.
  - Cada ola de la rejilla tiene su *bloop*.
  - El redoble acelera hacia el silencio.
  - El drop trae sub-drop y crash.
  - La explosión de partículas son 46 granos agudos repartidos en estéreo.
  - Cada corte del montaje tiene su acento.
  - El glitch se oye como *stutter* con rebanadas cada vez más cortas y bitcrush.
  - El subtítulo suena a "ding" más clics de tecleo.
- **Mezcla y máster:**
  - Sidechain ligado a la lista de bombos.
  - Delay ping-pong a corchea con puntillo.
  - **Reverb por convolución** (FFT propia) con una respuesta al impulso sintética: ruido decorrelado L/R, decaimiento exponencial y agudos que se amortiguan con el tiempo.
  - Compresor de bus y saturación tanh.
  - Normalización por **true-peak** (sobremuestreo ×4 con sinc enventanada) a −1 dBTP.
  - Dither TPDF a 16 bits.
- **Resultado:** ≈ −13 LUFS integrados, ≤ −1 dBTP.

## 4. Iteraciones

**Entorno.** Primero medí qué había en la máquina. Chromium sin ventana (headless) tiene WebGL2 por software (SwiftShader) con FBOs float. Las mediciones:

- Un raymarch de 64 pasos a 1080p tarda unos 220 ms.
- Un Canvas2D cargado, unos 190 ms.
- Una captura, unos 200 ms.

Con eso el motion blur de 8 subfotogramas era viable: unos 12–17 s por fotograma y por proceso, con 3 procesos en paralelo.

**Música v1 → v2.** No puedo escuchar el audio, así que lo audité con números y gráficos: RMS por pista, `ebur128` de ffmpeg, espectrograma y forma de onda.

| Problema en v1 | Solución en v2 |
|---|---|
| True peak de **+1,3 dBTP** (se habría distorsionado al codificar en AAC) | Medidor de true-peak propio |
| Melodía **13 dB por debajo** de los acordes | +7 dB a la melodía |

Resultado: −13,3 LUFS / −0,9 dBTP.

**Visual v1.** La primera pasada fue con 1 subfotograma, para iterar rápido, revisada en hojas de contactos de 16 fotogramas.

| Problema detectado | Corrección |
|---|---|
| Las marquesinas se solapaban ("OV**SPACING**"). Medí la anchura en el navegador y era correcta: Chromium corrompe `strokeText` en cadenas de más de unos 3.000 px | Dibujar por trozos usando los offsets medidos |
| El blob tapaba casi toda la palabra DEPTH | Cámara de 5,2 a 7,4 unidades; ahora solo la tapa en parte, y eso vende la profundidad |
| El bloom usaba el máximo de los canales RGB, así que el rojo puro "floreaba" y lavaba los fondos a gris | Umbral por **luminancia** (Rec.709) |
| Partículas sucias y FORM ilegible | Tamaño final atado al paso de la rejilla de muestreo (semitono legible), azul fuera de la paleta (sobre tinta no se ve), convergencia 100 ms antes, flujo curl más ancho y coherente |
| La máscara de *Claude* dejaba asomar el pie de las letras bajo la línea base | Ajustar el recorte |

**Visual v2.** Probé el motion blur real (8 subfotogramas) en 6 fotogramas clave antes del render completo: las estelas de partículas y la espiral de GRID funcionaban como esperaba.

**Render final, con tres tropiezos reales:**

| Intento | Qué pasó | Arreglo |
|---|---|---|
| 1 | Se cayó en el fotograma 121. Con 3 procesos raymarcheando por software, la captura de Playwright superó su timeout de 30 s | Captura de página sin timeout y render **reanudable** (salta los PNG que ya existen) |
| 2 | Se cayó en el primer fotograma de CODE ONLY. Los subfotogramas anteriores al corte daban un tiempo local negativo y, con él, un índice negativo en el array de líneas de código | Módulo positivo |
| 3 | Completo | — |

**QA sobre el MP4 ya decodificado** (no sobre los PNG):

| Problema | Arreglo |
|---|---|
| Los flashes de 4,0 s y 5,0 s salían **grises**, porque el obturador promediaba subfotogramas de antes del golpe, que no tenían flash | El flash vale 1 también antes del golpe |
| El fotograma 7,0, el golpe más fuerte de la música, estaba **casi vacío** (el círculo empieza en escala 0) | Fotograma de impacto **rojo pleno** que se disuelve en 4 fotogramas |
| La C de *Claude* asomaba **por debajo del círculo** mientras este se desplazaba | El borde izquierdo de la máscara del texto es ahora el propio círculo: el logo "empuja" el nombre al entrar |

Solo se volvieron a renderizar los 34 fotogramas afectados.

**Codificación.** Con CRF 15 y `-tune grain`, 4 s ocupaban 48 MB; el vídeo completo habría rozado el límite de 100 MB por archivo de GitHub. Comparé variantes en un tramo de 2 s y me quedé con **CRF 18 sin tune** (37 MB en total), sin banding visible en los degradados oscuros. Matriz BT.709 etiquetada correctamente y AAC a 320 kbps. Después de codificar, el audio sigue en −13,4 LUFS / −0,9 dBTP.

**Comprobación final:** 240 fotogramas, 8,000 s de vídeo y 8,000 s de audio, 1920×1080, 30/1 fps, yuv420p.

## 5. Lo que descarté (y por qué)

- **Renderizar en Python con numpy y PIL:** sin shaders, el 3D y el fluido habrían sido o lentos o pobres. Chromium sin ventana da Canvas2D y GLSL reales, y además un render determinista.
- **128 BPM:** 8 s no habrían cuadrado con un número entero de compases. 120 BPM da 4 compases exactos y 15 fotogramas por tiempo.
- **Que la pelota se dividiera en las dos O de MOTION** (mitosis con metaballs): encantador, pero demasiado caro para 0,3 s. Lo resolví con una O maciza y la otra como anillo que se dibuja, un eco más limpio.
- **Cuenta atrás "3·2·1"** en la anticipación: es un cliché. Funciona mejor quitar cosas: todo cae a un punto y llegan 125 ms de silencio antes del drop.
- **Sunburst de cuñas para LOOP:** se ve fechado. Lo cambié por arcos orbitales concéntricos con velocidades distintas, que con el motion blur se convierten en trazos de luz.
- **HUD con modo de fusión `difference`** para que se adaptara solo a cada fondo: sobre el bermellón daba un cian sucio. Elegí el color del HUD por escena.
- **Animar el peso de la tipografía:** no hay una Inter variable instalada y no quería fuentes externas. Sustituí ese gesto por el *skew* de látigo.
- **Reverb algorítmica de Schroeder:** suena metálica en colas cortas. La convolución con una respuesta al impulso sintética suena más cara.
- **Tape-stop real sobre el máster:** complicado sin remuestreo variable. El *stutter* con bitcrush cuenta lo mismo ("se rompe") y además clava el glitch visual.
- **Más de 8 subfotogramas:** 16 no se distinguían en las escenas rápidas y duplicaban el tiempo de render.

## 6. Cómo reproducirlo

```bash
cd showreel && ./build.sh        # ~20 min en 4 núcleos sin GPU
```

## 7. Tiempo total

**≈ 1 h 10 min** de reloj, de principio a fin (inicio a las 03:59 UTC, entrega hacia las 05:09 UTC, mismo día).

| Fase | Tiempo aprox. |
|---|---|
| Exploración del entorno y benchmarks (WebGL, Canvas, captura) | 5 min |
| Diseño de la pieza: guion por tiempos, paleta, transiciones | 5 min |
| Síntesis musical: escritura, auditoría con medidores y 2 iteraciones | 10 min |
| Motor visual: 8 escenas, HUD, acumulación y post-proceso | 15 min |
| Previsualizaciones con 1 subfotograma, hojas de contactos y correcciones | 5 min |
| Render final con 8 subfotogramas (incluye 2 caídas y reanudaciones) | 30 min |
| QA sobre el MP4, re-render parcial, codificación y este documento | 10 min |

Tiempo de máquina del render limpio: unos 20 min para 1.920 subfotogramas en 4 núcleos de CPU, sin GPU (SwiftShader).
