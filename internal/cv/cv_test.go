package cv

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"io"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestValidateRoles(t *testing.T) {
	roles, err := ValidateRoles([]Role{{
		Title: "  Project   manager ", Profession: "pm", MinYears: 5,
		SkillsMust:   []string{"Jira", " jira ", "", "Scrum"},
		Certificates: []string{"PMP"},
		Languages:    []LangReq{{Language: "EN", Level: "b2"}, {Language: "en", Level: "C1"}, {Language: "ru"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	r := roles[0]
	if r.Title != "Project manager" || r.Count != 1 || !slices.Equal(r.SkillsMust, []string{"Jira", "Scrum"}) {
		t.Errorf("not normalised: %+v", r)
	}
	if len(r.Languages) != 2 || r.Languages[0] != (LangReq{"en", "B2"}) || r.Languages[1] != (LangReq{"ru", ""}) {
		t.Errorf("languages: %+v", r.Languages)
	}
	for _, bad := range []Role{{}, {Title: "x", Profession: "cook"}, {Title: "x", MinYears: -1},
		{Title: "x", Languages: []LangReq{{Language: "xx"}}}, {Title: "x", Languages: []LangReq{{Language: "en", Level: "good"}}}} {
		if _, err := ValidateRoles([]Role{bad}); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestAnonymize(t *testing.T) {
	raw := json.RawMessage(`{"basics":{"name":"Ахметов Арман","email":"a@b.kz","phone":"+7 701","label":"PM","location":{"city":"Астана"}},"work":[{"position":"PM"}]}`)
	c := &Candidate{FullName: "Ахметов Арман", FileName: "Akhmetov_CV.pdf", ConsentNote: "signed by Arman", Profile: raw}
	v := view(c, true)
	out, _ := json.Marshal(v)
	for _, leak := range []string{"Ахметов", "a@b.kz", "+7 701", "Akhmetov", "Arman"} {
		if strings.Contains(string(out), leak) {
			t.Errorf("anonymised view leaks %q: %s", leak, out)
		}
	}
	if !strings.Contains(string(out), `"label":"PM"`) || !v.Anonymized {
		t.Errorf("job title must stay: %s", out)
	}
	if view(c, false) != c {
		t.Error("full view must be unchanged")
	}
	// the name, e-mails and phones repeated in other texts, and a title line that is an address or personal data
	raw2 := json.RawMessage(`{"basics":{"name":"JUAN P. DELA CRUZ JR.","label":"Kazakhstan, Aksay city, Abay street, 12"},
		"work":[{"position":"Pipe Fitter","summary":"Juan Dela Cruz led a team; call +63 917 555 0199 or write juan@mail.ph. 2012 - 2016 at Alpha"}]}`)
	c2 := &Candidate{FullName: "JUAN P. DELA CRUZ JR.", Profile: raw2}
	out2, _ := json.Marshal(view(c2, true))
	for _, leak := range []string{"Juan", "JUAN", "Cruz", "CRUZ", "917 555", "juan@mail", "Abay"} {
		if strings.Contains(string(out2), leak) {
			t.Errorf("anonymised view leaks %q: %s", leak, out2)
		}
	}
	if !strings.Contains(string(out2), "2012 - 2016 at Alpha") || !strings.Contains(string(out2), "Pipe Fitter") {
		t.Errorf("anonymising removed ordinary text: %s", out2)
	}
	if born, _ := json.Marshal(view(&Candidate{Profile: json.RawMessage(`{"basics":{"label":"Male, born on 3 March 1990"}}`)}, true)); strings.Contains(string(born), "1990") {
		t.Errorf("personal data as the title: %s", born)
	}
	// the name as the title of a CV where the parser found no name: masked in the other texts too (the signature)
	if nm, _ := json.Marshal(view(&Candidate{Profile: json.RawMessage(`{"basics":{"label":"JOHN Q. PUBLIC JR."},
		"work":[{"summary":"I declare the above is true. ____ JOHN Q. PUBLIC JR. ____ Date"}]}`)}, true)); strings.Contains(strings.ToUpper(string(nm)), "PUBLIC") || strings.Contains(string(nm), "JOHN") {
		t.Errorf("the name as the title: %s", nm)
	}
	// the parsed name differs from the candidate's name (an English CV of a person entered in Russian)
	if nm, _ := json.Marshal(view(&Candidate{FullName: "Ахметов Арман Болатович", Error: "tesseract: Arman Akhmetov", Profile: json.RawMessage(`{"basics":{"name":"Arman Akhmetov","summary":"Arman Akhmetov has 10 years in ERP"}}`)}, true)); strings.Contains(string(nm), "Akhmetov") {
		t.Errorf("the parsed name leaks: %s", nm)
	}
	// the name glued into one word: masked in the other texts too
	if nm, _ := json.Marshal(view(&Candidate{Profile: json.RawMessage(`{"basics":{"label":"JOHNPUBLIC"},"work":[{"summary":"Signed: JOHNPUBLIC"}]}`)}, true)); strings.Contains(string(nm), "JOHNPUBLIC") {
		t.Errorf("the glued name as the title: %s", nm)
	}
	for _, title := range []string{"PIPE FITTER", "E&I TECHNICIAN", "Senior Civil Engineer | Construction & Project Management", "QA/QC ENGINEER", "PLUMBER", "ELECTRICIAN", "SCAFFOLDER"} {
		if personalLabel(title) {
			t.Errorf("%q is a job title", title)
		}
	}
}

func TestBuildDocx(t *testing.T) {
	var p profile
	_ = json.Unmarshal([]byte(`{"basics":{"name":"Ахметов <Арман> & Co","label":"Руководитель проектов","summary":"Внедрения ERP 10 лет"},
		"work":[{"name":"ТОО «Нурсофт»","position":"PM","startDate":"2019-03","endDate":null,"summary":"Scrum","location":{"country":"KZ","city":"astana"}},
		        {"name":"Freelance","position":"BA","startDate":"2017-01","endDate":"2019-02","location":{"country":null,"city":"Самарканд-2"}}],
		"projects":[{"name":"ERP для Казпочты","role":"руководитель","customer":"АО «Казпочта»","startDate":"2021-01","endDate":"2022-12","summary":"40 филиалов"}],
		"education":[{"institution":"Университет","area":"ИС","endDate":"2007","degree":"master"}],"skills":[{"name":"Jira"}],
		"languages":[{"language":"en","fluency":"B2"}],"certificates":[{"name":"PMP","date":"2020"}],"meta":{"totalYears":12.5}}`), &p)
	meta := json.RawMessage(`{"countries":[{"code":"KZ","en":"Kazakhstan","ru":"Казахстан"}],"cities":[{"id":"astana","country":"KZ","en":"Astana","ru":"Астана"}]}`)
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	parts := func(lh *docLetterhead) map[string]string {
		body, err := buildDocx(&p, "ru", placeLabels(meta, "ru"), lh, now)
		if err != nil {
			t.Fatal(err)
		}
		zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, f := range zr.File {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			if strings.HasSuffix(f.Name, ".xml") || strings.HasSuffix(f.Name, ".rels") {
				if err := xml.Unmarshal(b, new(struct{})); err != nil {
					t.Errorf("%s is not well-formed XML: %v", f.Name, err)
				}
			}
			out[f.Name] = string(b)
		}
		return out
	}
	plain := parts(nil)
	doc := plain["word/document.xml"]
	for _, want := range []string{"Ахметов &lt;Арман&gt; &amp; Co", "Рекомендуемая должность: Руководитель проектов", "Общий стаж: 12,5 года",
		"мар. 2019 – по н.в. (7 лет 9 мес.)", "янв. 2017 – фев. 2019 (2 года 2 мес.)", "Английский (B2)", "PMP (2020)",
		"ТОО «Нурсофт», Астана, Казахстан", "Freelance, Самарканд-2", "Работодатель", "Основные обязанности", "Проекты", "ERP для Казпочты",
		"янв. 2021 – дек. 2022 (2 года)", "руководитель; Заказчик: АО «Казпочта»; 40 филиалов", "Магистр – ИС, Университет, 2007", "Внедрения ERP 10 лет"} {
		if !strings.Contains(doc, want) {
			t.Errorf("document.xml misses %q", want)
		}
	}
	if _, ok := plain["word/header1.xml"]; ok || strings.Contains(doc, "headerReference") {
		t.Error("no letterhead asked, a header made")
	}
	// on a letterhead: the logo and the lines in the header, the company in the footer
	logo, err := logos.ReadFile("letterheads/gs.jpg")
	if err != nil {
		t.Fatal(err)
	}
	withLH := parts(&docLetterhead{logo: logo, ext: "jpg", width: 1370000, height: 432000,
		header: []string{"Alpha & Co LLP", "*Your projects, staffed*", "Astana"}, footer: []string{"Alpha & Co LLP", "+7 700 000 00 00"}})
	if h := withLH["word/header1.xml"]; !strings.Contains(h, "Alpha &amp; Co LLP") || !strings.Contains(h, `<w:i/>`) || !strings.Contains(h, `r:embed="rIdLogo"`) || strings.Contains(h, "*") {
		t.Errorf("header: %s", h)
	}
	if !strings.Contains(withLH["word/footer1.xml"], "+7 700 000 00 00") || withLH["word/media/logo.jpg"] != string(logo) ||
		!strings.Contains(withLH["word/document.xml"], `<w:headerReference w:type="default" r:id="rIdH"/><w:footerReference`) {
		t.Error("footer, logo or section references missing")
	}
}

func TestNameAfterParse(t *testing.T) {
	for _, c := range []struct{ stored, prev, parsed, want string }{
		{"", "", "Иванов Пётр", "Иванов Пётр"},                                  // a new CV
		{"Old Parse", "Old Parse", "Иванов Пётр", "Иванов Пётр"},                // nobody typed it
		{"ПЕРСОНАЛЬНОЕ ПОРТФОЛИО", "Иванов Пётр", "Иванов Пётр", "Иванов Пётр"}, // an older parser's mistake
		{" Curriculum Vitae ", "x", "Ivan Petrov", "Ivan Petrov"},
		{"Иванов Пётр (проверено)", "Иванов Пётр", "Иванов Пётр", "Иванов Пётр (проверено)"}, // typed by a person
		{"Old Parse", "Old Parse", "", "Old Parse"},                                          // no name found now
	} {
		if got := nameAfterParse(c.stored, c.prev, c.parsed); got != c.want {
			t.Errorf("nameAfterParse(%q, %q, %q) = %q, want %q", c.stored, c.prev, c.parsed, got, c.want)
		}
	}
}

func TestLetterheadText(t *testing.T) {
	if s, err := cleanLetterheadText("header", " Alpha LLP \r\n‮Astana\u0007\n\n"); err != nil || s != "Alpha LLP\nAstana" {
		t.Fatalf("%q %v", s, err)
	}
	if _, err := cleanLetterheadText("header", strings.Repeat("x\n", 9)); err == nil {
		t.Error("9 lines accepted")
	}
	if _, err := cleanLetterheadText("footer", strings.Repeat("x", 201)); err == nil {
		t.Error("a 201-character line accepted")
	}
}

func TestTranslations(t *testing.T) {
	profile := json.RawMessage(`{"basics":{"name":"Ахметов Арман","email":"a@b.kz","label":"Руководитель проектов"},
		"work":[{"position":"Руководитель проектов","name":"ТОО «Нурсофт»","summary":"Внедрение ERP"}],
		"skills":[{"name":"Jira"},{"name":"Управление рисками"}],"meta":{"positions":[{"title":"Руководитель проектов"}]}}`)
	texts := ProfileTexts(profile)
	if texts["work.0.position"] != "Руководитель проектов" || texts["skills.1.name"] != "Управление рисками" || len(texts) != 7 {
		t.Fatalf("texts: %v", texts)
	}
	for k, v := range texts {
		if strings.Contains(v, "Ахметов") || strings.Contains(v, "a@b.kz") {
			t.Errorf("personal data among the texts to translate: %s=%s", k, v)
		}
	}
	en := map[string]string{"basics.label": "Project Manager", "work.0.position": "Project Manager", "skills.1.name": "Risk management"}
	saved, _ := json.Marshal(map[string]translation{"en": {Source: textsHash(texts), Texts: en}})
	valid, status := translationState(saved, profile, "Ахметов Арман")
	if status["en"] != "ok" || status["ru"] != "missing" || valid["en"]["basics.label"] != "Project Manager" {
		t.Errorf("state: %v %v", status, valid)
	}
	var p struct {
		Basics struct{ Name, Label string }
		Work   []struct{ Position, Name string }
		Skills []struct{ Name string }
	}
	_ = json.Unmarshal(applyTexts(profile, valid["en"]), &p)
	if p.Basics.Label != "Project Manager" || p.Work[0].Position != "Project Manager" || p.Work[0].Name != "ТОО «Нурсофт»" ||
		p.Skills[1].Name != "Risk management" || p.Basics.Name != "Ахметов Арман" {
		t.Errorf("applied: %+v", p)
	}
	// the profile changed after translating: the translation is outdated and hidden
	edited := json.RawMessage(strings.Replace(string(profile), "Внедрение ERP", "Внедрение CRM", 1))
	if valid, status := translationState(saved, edited, "Ахметов Арман"); status["en"] != "outdated" || valid["en"] != nil {
		t.Errorf("edited: %v %v", status, valid)
	}
	// a translation of texts that held a name the anonymiser now masks (made before a fix): outdated, never shown
	signed := json.RawMessage(strings.Replace(string(profile), "Внедрение ERP", "Внедрение ERP. Арман Ахметов", 1))
	leaky, _ := json.Marshal(map[string]translation{"en": {Source: textsHash(ProfileTexts(signed)), Texts: en}})
	if _, status := translationState(leaky, signed, "Ахметов Арман"); status["en"] != "outdated" {
		t.Errorf("a translation of unmasked texts stays valid: %v", status)
	}
	// paths that do not exist are ignored
	if out := applyTexts(profile, map[string]string{"work.5.position": "x", "basics.label.x": "y"}); !strings.Contains(string(out), "Руководитель") {
		t.Errorf("bad paths changed the profile: %s", out)
	}
}

// A page of English that the Kazakh+Russian+English models turned partly Cyrillic is read again in English; a Russian
// CV full of English terms is not.
func TestLatinShare(t *testing.T) {
	diploma := "hereby confers цшроп .\n— Башек А;ъаш-нш\nBachelor of Science\nin Civil Engineering\nwith all the Honours and Distinctions belonging to\nthe School of Engineering and Applied Sciences"
	russian := "Руководитель проектов\nВнедрение Jira, Confluence и Scrum в ТОО «Нурсофт», управление рисками и бюджетом проекта"
	if s := latinShare(diploma); s < latinOCR {
		t.Errorf("diploma page: latin share %.2f, want >= %.2f", s, latinOCR)
	}
	if s := latinShare(russian); s >= latinOCR {
		t.Errorf("russian cv: latin share %.2f, want < %.2f", s, latinOCR)
	}
}

// The Go list of professions (validation, MCP enum) must match the engine.
func TestProfessionsMatchEngine(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := &Engine{Node: node, Dir: filepath.Join("..", "..", "cvengine")}
	raw, err := e.Meta(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Professions []struct{ ID string } `json:"professions"`
		Languages   []string              `json:"languages"`
		Levels      []string              `json:"levels"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, p := range m.Professions {
		ids = append(ids, p.ID)
	}
	if !slices.Equal(ids, Professions) || !slices.Equal(m.Languages, Languages) || !slices.Equal(m.Levels, Levels) {
		t.Errorf("engine %v %v %v, Go %v %v %v", ids, m.Languages, m.Levels, Professions, Languages, Levels)
	}
	profile, err := e.Parse(context.Background(), "Иван Петров\nDevOps-инженер\n\nОПЫТ РАБОТЫ\n01.2020 - 12.2023\nТОО «Альфа»\nDevOps-инженер\nDocker, Kubernetes\n", false)
	if err != nil || !strings.Contains(string(profile), `"Kubernetes"`) {
		t.Fatalf("parse through the CLI: %v %s", err, profile)
	}
}
