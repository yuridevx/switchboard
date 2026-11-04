package keeper

import (
	"encoding/json"

	"switchboard/keeper/internal/release"
)

// Entry — часть в плане машины: stable уже раскрыт в версию, ссылка на архив живёт час.
type Entry struct {
	Part    string            `json:"part"`
	Version string            `json:"version"`
	Sha256  string            `json:"sha256"`
	URL     string            `json:"url"`
	On      *bool             `json:"on,omitempty"`
	Force   bool              `json:"force,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

func (e Entry) on() bool { return e.On == nil || *e.On }

func (e Entry) source() release.Source {
	return release.Source{Part: e.Part, Version: e.Version, Sha256: e.Sha256, URL: e.URL}
}

// sameEnv — окружение части то же.
func (e Entry) sameEnv(o Entry) bool {
	a, _ := json.Marshal(e.Env)
	b, _ := json.Marshal(o.Env)
	return string(a) == string(b)
}

// sameEntry — запись части не менялась; ссылка не в счёт: она живёт час.
func (e Entry) sameEntry(o Entry) bool {
	return e.Version == o.Version && e.Sha256 == o.Sha256 && e.on() == o.on() && e.Force == o.Force && e.sameEnv(o)
}

// Plan — план машины от «выпусков»; rev растёт.
type Plan struct {
	Rev   int     `json:"rev"`
	Parts []Entry `json:"parts"`
}

func (p Plan) find(name string) (Entry, bool) {
	for _, e := range p.Parts {
		if e.Part == name {
			return e, true
		}
	}
	return Entry{}, false
}
