--[[
  logo-partners-rotator.lua — FIP Gold Bucharest 2026 stream helper

  Alternates two OBS sources on a fixed cycle:
      Logo source      visible for "Logo time"      (default 30 s — test value)
      Partners source  visible for "Partners time"  (default 10 s — test value)
  ...and repeats until the "Enabled" box is unticked.

  Install once:  OBS → Tools → Scripts → "+" → pick this file.
  Then, in the script's settings: choose the two source names, adjust the
  times if needed, and tick "Enabled". The cycle always (re)starts with the
  logo. Unticking "Enabled" (or changing any setting) shows the logo again.

  Visibility is applied in EVERY scene that contains the sources, so the
  rotation keeps working no matter which scene is live.
]]

local obs = obslua

local cfg = {
  logo = "",
  partners = "",
  logo_secs = 540,
  partner_secs = 60,
  enabled = false,
}

local phase = 1 -- 1 = logo showing, 2 = partners showing
local advance    -- forward declaration, defined below (timer callback)

-- Show/hide every scene item (in any scene, including inside groups)
-- whose source has this name.
local function set_visible_everywhere(source_name, visible)
  if source_name == nil or source_name == "" then return end
  local scenes = obs.obs_frontend_get_scenes()
  if scenes == nil then return end
  for _, scene_source in ipairs(scenes) do
    local scene = obs.obs_scene_from_source(scene_source)
    local item = obs.obs_scene_find_source_recursive(scene, source_name)
    if item ~= nil then
      obs.obs_sceneitem_set_visible(item, visible)
    end
  end
  obs.source_list_release(scenes)
end

local function apply_phase()
  set_visible_everywhere(cfg.logo, phase == 1)
  set_visible_everywhere(cfg.partners, phase == 2)
end

local function stop_cycle()
  obs.timer_remove(advance)
end

local function start_cycle()
  stop_cycle()
  phase = 1
  apply_phase()
  obs.timer_add(advance, cfg.logo_secs * 1000)
end

advance = function()
  obs.remove_current_callback()
  if not cfg.enabled then return end
  if phase == 1 then
    phase = 2
    apply_phase()
    obs.timer_add(advance, cfg.partner_secs * 1000)
  else
    phase = 1
    apply_phase()
    obs.timer_add(advance, cfg.logo_secs * 1000)
  end
end

-- Re-apply after OBS finishes loading (or the scene collection changes),
-- otherwise a "partners" state saved in the scene collection could linger
-- on screen after a restart until the first switch fires.
local function on_frontend_event(event)
  if event == obs.OBS_FRONTEND_EVENT_FINISHED_LOADING
     or event == obs.OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGED then
    if cfg.enabled and cfg.logo ~= "" and cfg.partners ~= "" then
      start_cycle()
    else
      phase = 1
      apply_phase()
    end
  end
end

-- -------------------------------------------------------------------------
-- OBS script entry points
-- -------------------------------------------------------------------------

function script_description()
  return [[<b>Logo / Partners rotator</b><br/>
Shows the Logo source, then the Partners source, on a repeating timed cycle
(defaults: 30 seconds logo, 10 seconds partners — test values; for the
tournament use 540 / 60).<br/><br/>
Pick the two sources, then tick <b>Enabled</b>. The cycle always starts
with the logo; unticking Enabled shows the logo again.]]
end

function script_properties()
  local props = obs.obs_properties_create()

  local p_logo = obs.obs_properties_add_list(props, "logo", "Logo source",
    obs.OBS_COMBO_TYPE_EDITABLE, obs.OBS_COMBO_FORMAT_STRING)
  local p_partners = obs.obs_properties_add_list(props, "partners", "Partners source",
    obs.OBS_COMBO_TYPE_EDITABLE, obs.OBS_COMBO_FORMAT_STRING)

  local names = {}
  local sources = obs.obs_enum_sources()
  if sources ~= nil then
    for _, src in ipairs(sources) do
      table.insert(names, obs.obs_source_get_name(src))
    end
    obs.source_list_release(sources)
  end
  table.sort(names)
  for _, n in ipairs(names) do
    obs.obs_property_list_add_string(p_logo, n, n)
    obs.obs_property_list_add_string(p_partners, n, n)
  end

  obs.obs_properties_add_int(props, "logo_secs", "Logo time (seconds)", 1, 86400, 1)
  obs.obs_properties_add_int(props, "partner_secs", "Partners time (seconds)", 1, 86400, 1)
  obs.obs_properties_add_bool(props, "enabled", "Enabled (run the cycle)")

  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_int(settings, "logo_secs", 30)    -- test value (tournament: 540)
  obs.obs_data_set_default_int(settings, "partner_secs", 10) -- test value (tournament: 60)
  obs.obs_data_set_default_bool(settings, "enabled", false)
end

function script_update(settings)
  cfg.logo = obs.obs_data_get_string(settings, "logo")
  cfg.partners = obs.obs_data_get_string(settings, "partners")
  cfg.logo_secs = math.max(1, obs.obs_data_get_int(settings, "logo_secs"))
  cfg.partner_secs = math.max(1, obs.obs_data_get_int(settings, "partner_secs"))
  cfg.enabled = obs.obs_data_get_bool(settings, "enabled")

  if cfg.enabled and cfg.logo ~= "" and cfg.partners ~= "" then
    start_cycle()
  else
    stop_cycle()
    phase = 1
    apply_phase() -- back to the default look: logo on, partners off
  end
end

function script_load(_settings)
  obs.obs_frontend_add_event_callback(on_frontend_event)
end

function script_unload()
  stop_cycle()
end
