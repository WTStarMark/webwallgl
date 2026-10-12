#define PI 3.1415927
#define STEPS 100
#define AO_STEPS 8
#define SMOOTHING_VAL 0.06
#define numBlobs 120

const float GRADIENT_ROTATION = 0.0;
const float CAMERA_DISTANCE = 4.5;
const float EDGE_SMOOTHNESS = 0.05;
const float EDGE_WIDTH = 1.0;
const float MIN_BLOB_SIZE = 0.02;
const float CENTER_CONCENTRATION = 1.0;
const float FL = 2.0;
const vec3 LOOK_AT = vec3(0.0, 0.0, 0.0);
const vec3 HIGHLIGHT1_COLOR = vec3(1.0, 1.0, 1.0);
const float HIGHLIGHT1_INTENSITY = 0.5;
const float HIGHLIGHT1_CONCENTRATION = 16.0;
const float HIGHLIGHT1_H = 136.0;
const float HIGHLIGHT1_V = 180.0;
const vec3 HIGHLIGHT2_COLOR = vec3(0.8, 0.8, 1.0);
const float HIGHLIGHT2_INTENSITY = 0.3;
const float HIGHLIGHT2_CONCENTRATION = 16.0;
const float HIGHLIGHT2_H = 60.0;
const float HIGHLIGHT2_V = 20.0;

vec4 hash41(float src) {
	vec4 p4 = fract(vec4(src, src, src, src) * vec4(0.1031, 0.1136, 0.1375, 0.1543));
	p4 += dot(p4, p4.wzxy + 33.33);
	return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

float smin(float a, float b, float k) {
	k *= 6.0;
	float h = max(k - abs(a - b), 0.0) / k;
	return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

vec4 getBlob(int i, float time) {
	vec4 rand1 = hash41(float(i));
	vec4 rand2 = hash41(float(i) * 1.3145);
	vec3 freq = mix(vec3(0.4, 0.4, 0.4), vec3(2.8, 2.8, 2.8), rand1.xyz);
	vec3 phase = mix(vec3(0.0, 0.0, 0.0), vec3(2.0 * PI, 2.0 * PI, 2.0 * PI), rand2.xyz);
	float moveRad = mix(0.2, 1.0, rand2.w);
	float rad = max(mix(0.15, 0.5, rand1.w * rand1.w) * exp(-moveRad * 1.75), MIN_BLOB_SIZE);
	freq *= g_FxSpeed;
	rad *= g_FxScale;
	moveRad *= g_FxMotion;
	vec3 bp = vec3(sin(time * freq.x + phase.x), cos(time * freq.y + phase.y), sin(time * freq.z + phase.z)) * vec3(moveRad, moveRad, moveRad);
	return vec4(bp, rad);
}

float map(vec3 p) {
	float d = 100000.0;
	int blobCount = int(g_FxBlobs);
	for (int i = 0; i < blobCount; i++) {
		if (i >= numBlobs) break;
		vec4 blob = getBlob(i, g_Time);
		d = smin(d, length(p - blob.xyz) - blob.w, SMOOTHING_VAL * g_FxFusion);
	}
	return d;
}

float March(vec3 ro, vec3 rd, out float endD) {
	float t = 0.0;
	for (int i = 0; i < STEPS; i++) {
		vec3 p = ro + t * rd;
		float d = map(p);
		endD = d;
		if (d < 0.001) return t;
		t += d;
		if (t > 20.0) return t;
	}
	return t;
}

vec3 Normal(vec3 p) {
	const float h = 0.001;
	const vec2 k = vec2(1.0, -1.0);
	return normalize(k.xyy * map(p + k.xyy * h) +
	                 k.yyx * map(p + k.yyx * h) +
	                 k.yxy * map(p + k.yxy * h) +
	                 k.xxx * map(p + k.xxx * h));
}

float AO(vec3 pos, vec3 nor) {
	float occ = 0.0;
	float sca = 1.0;
	for (int i = 0; i < AO_STEPS; i++) {
		float t = 0.01 + 0.08 * float(i);
		float d = map(pos + t * nor);
		occ += (t - d) * sca;
		sca *= 0.85;
	}
	return clamp(1.0 - occ / 3.14, 0.0, 1.0);
}

vec3 Render(vec3 ro, vec3 rd, float d) {
	vec3 p = ro + d * rd;
	vec3 nor = Normal(p);
	vec3 lightDir = normalize(vec3(-1.0, 2.0, 0.0));
	float ssFake = clamp(dot(nor, lightDir) * 0.5 + 0.5, 0.0, 1.0);
	float ao = AO(p, nor);
	float ambientStrength = 0.2 + 0.6 * clamp((CENTER_CONCENTRATION - 0.1) / 2.9, 0.0, 1.0);
	vec3 lighting = mix(vec3(ambientStrength, ambientStrength, ambientStrength), vec3(1.0, 1.0, 1.0), ssFake);
	vec3 liquidCol = g_FxLiquid * lighting * (ao * 0.5 + 0.5);
	vec3 highlight1Dir = normalize(vec3(
		cos(HIGHLIGHT1_H * PI / 180.0) * sin(HIGHLIGHT1_V * PI / 180.0),
		cos(HIGHLIGHT1_V * PI / 180.0),
		sin(HIGHLIGHT1_H * PI / 180.0) * sin(HIGHLIGHT1_V * PI / 180.0)
	));
	vec3 highlight2Dir = normalize(vec3(
		cos(HIGHLIGHT2_H * PI / 180.0) * sin(HIGHLIGHT2_V * PI / 180.0),
		cos(HIGHLIGHT2_V * PI / 180.0),
		sin(HIGHLIGHT2_H * PI / 180.0) * sin(HIGHLIGHT2_V * PI / 180.0)
	));
	vec3 refDir = reflect(rd, nor);
	float highlight1 = pow(clamp(dot(refDir, highlight1Dir), 0.0, 1.0), HIGHLIGHT1_CONCENTRATION);
	float highlight2 = pow(clamp(dot(refDir, highlight2Dir), 0.0, 1.0), HIGHLIGHT2_CONCENTRATION);
	liquidCol += HIGHLIGHT1_COLOR * highlight1 * HIGHLIGHT1_INTENSITY;
	liquidCol += HIGHLIGHT2_COLOR * highlight2 * HIGHLIGHT2_INTENSITY;
	float gradientAngle = GRADIENT_ROTATION * PI / 180.0;
	float gradientFactor = clamp(dot(p.xy, vec2(cos(gradientAngle), sin(gradientAngle))) * 0.5 + 0.5, 0.0, 1.0);
	float rimIntensity = pow(1.0 - abs(dot(rd, nor)), 4.0 / max(0.1, EDGE_WIDTH)) * g_FxEdgeglow;
	liquidCol += mix(g_FxEdge1, g_FxEdge2, gradientFactor) * rimIntensity;
	return clamp(liquidCol, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
}

void main() {
	vec2 uv = v_TexCoord * 2.0 - 1.0;
	uv.x *= g_TexelSize.y / g_TexelSize.x;
	vec3 ro = vec3(0.0, 0.0, CAMERA_DISTANCE);
	vec3 cf = normalize(LOOK_AT - ro);
	vec3 cr = normalize(cross(cf, vec3(0.0, 1.0, 0.0)));
	vec3 cu = normalize(cross(cr, cf));
	vec3 rd = normalize(uv.x * cr + uv.y * cu + FL * cf);
	float endD;
	float d = March(ro, rd, endD);
	float edgeAlpha = 1.0 - smoothstep(0.001, 0.001 + EDGE_SMOOTHNESS, endD);
	vec3 col = vec3(0.0, 0.0, 0.0);
	if (edgeAlpha > 0.0) col = Render(ro, rd, d);
	col = pow(col, vec3(1.0 / 2.2, 1.0 / 2.2, 1.0 / 2.2));
	gl_FragColor = vec4(col, g_FxAlpha * edgeAlpha);
}
