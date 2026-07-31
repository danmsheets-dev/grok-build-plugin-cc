# grok-build whole-project check for Godot 4.
# Invoked as: godot --headless --path . --script res://.grok/plugins/grok-build-runtime/tools/grok_check.gd --quit
#
# Bare `--check-only` WITHOUT `--script` never exits (boots main_scene forever).
# This script walks res://, loads every .gd / .gdshader / .tscn / .tres, counts
# load failures, and quits with a real non-zero exit so the bridge can verify.
#
# Failure detection is type-aware: ResourceLoader.load() returns a non-null
# GDScript for a parse-broken script (can_instantiate() is false), and a
# non-null Shader for a compile-broken .gdshader (only surfaces when code is
# forced through the material/shader compiler). Do not treat null alone as the
# only failure signal.
extends SceneTree

const SKIP_DIRS := {
	".godot": true,
	".import": true,
	".git": true,
	"node_modules": true,
	".grok-build": true,
	# Still walk .grok so tools stay loadable, but skip deep plugin caches if any.
}

const LOAD_EXTS := {
	"gd": true,
	"gdshader": true,
	"gdshaderinc": true,
	"tscn": true,
	"tres": true,
}

# Path of this running script — must never ResourceLoader.load() it (segfault /
# runaway recursion: loading the SceneTree main-loop script while it is running).
var _self_path: String = ""
# Optional Logger (Godot 4.5+) that counts engine errors during each load.
var _error_counter: Object = null


func _init() -> void:
	var script_res: Script = get_script() as Script
	if script_res != null:
		_self_path = script_res.resource_path

	_error_counter = _make_error_counter()
	if _error_counter != null and OS.has_method("add_logger"):
		OS.add_logger(_error_counter)

	var failures := _walk("res://")

	if _error_counter != null and OS.has_method("remove_logger"):
		OS.remove_logger(_error_counter)

	print("GROK_CHECK: failures=", failures)
	quit(0 if failures == 0 else 1)


func _make_error_counter() -> Object:
	# Logger + OS.add_logger arrived in Godot 4.5. Build the subclass at runtime
	# so this file still parses on older 4.x (shader compile detection degrades
	# there; GDScript still uses can_instantiate()).
	if not ClassDB.class_exists("Logger"):
		return null
	if not OS.has_method("add_logger"):
		return null
	var gds := GDScript.new()
	gds.source_code = """extends Logger
var count: int = 0
func _log_error(_function, _file, _line, _code, _rationale, _editor_notify, _error_type, _script_backtraces) -> void:
	count += 1
func _log_message(_message: String, error: bool) -> void:
	if error:
		count += 1
"""
	var err := gds.reload()
	if err != OK:
		return null
	if not gds.can_instantiate():
		return null
	return gds.new()


func _error_count() -> int:
	if _error_counter == null:
		return 0
	return int(_error_counter.get("count"))


func _walk(dir_path: String) -> int:
	var failures := 0
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return 0
	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if name == "." or name == "..":
			name = dir.get_next()
			continue
		var child: String
		if dir_path.ends_with("/"):
			child = dir_path + name
		else:
			child = dir_path + "/" + name
		if dir.current_is_dir():
			if SKIP_DIRS.has(name) or name.begins_with("."):
				name = dir.get_next()
				continue
			failures += _walk(child)
		else:
			var ext := name.get_extension().to_lower()
			if LOAD_EXTS.has(ext):
				if not _check_resource(child):
					failures += 1
					push_error("GROK_CHECK failed to load: " + child)
		name = dir.get_next()
	dir.list_dir_end()
	return failures


func _check_resource(path: String) -> bool:
	# Never re-load the script that is currently the SceneTree main loop.
	if path == _self_path:
		return true

	var err_before := _error_count()
	# CACHE_MODE_IGNORE avoids sticky failures from a prior half-load.
	var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)

	if res == null:
		return false

	# GDScript (and other Script types): parse failures still return a non-null
	# resource; can_instantiate() is the reliable discriminator.
	if res is Script:
		if not (res as Script).can_instantiate():
			return false

	# PackedScene: refuse scenes that cannot be instantiated.
	if res is PackedScene:
		if not (res as PackedScene).can_instantiate():
			return false

	# Shader: load always yields a Shader; force a compile via ShaderMaterial.
	if res is Shader:
		var mat := ShaderMaterial.new()
		mat.shader = res as Shader

	# ShaderInclude: only fails at compile time when pulled into a shader.
	if res is ShaderInclude:
		var wrap := Shader.new()
		wrap.code = (
			"shader_type canvas_item;\n#include \"%s\"\nvoid fragment(){COLOR=vec4(1.0);}\n" % path
		)
		var mat2 := ShaderMaterial.new()
		mat2.shader = wrap

	# Any engine error raised during load/compile counts as failure when we
	# have a Logger. Covers .tscn/.tres parse noise that still returned a
	# partial Resource in edge cases, and shader compile failures above.
	if _error_counter != null and _error_count() > err_before:
		return false

	return true
