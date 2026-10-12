	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float p = dot(v_TexCoord - vec2(0.5, 0.5), vec2(cos(g_FxAngle), sin(g_FxAngle))) + 0.5;
	float lo = min(g_FxStart, g_FxEnd);
	float hi = max(g_FxStart, g_FxEnd) + 0.0001;
	float m = smoothstep(lo, hi, p);
	c.a *= g_FxStart <= g_FxEnd ? m : 1.0 - m;
	gl_FragColor = c;
