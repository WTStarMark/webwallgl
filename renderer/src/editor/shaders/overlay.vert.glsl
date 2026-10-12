#version 300 es
in vec2 aPos;
uniform vec2 uViewport;
uniform float uDepth;
void main() {
  float x = (aPos.x / uViewport.x) * 2.0 - 1.0;
  float y = 1.0 - (aPos.y / uViewport.y) * 2.0;
  gl_Position = vec4(x, y, uDepth, 1.0);
}
