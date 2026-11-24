package cv

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/workflow"
)

// profile is the part of an engine profile that goes into an exported CV.
type profile struct {
	Basics struct {
		Name     string `json:"name"`
		Label    string `json:"label"`
		Summary  string `json:"summary"`
		Location struct {
			City string `json:"city"`
		} `json:"location"`
	} `json:"basics"`
	Work []struct {
		Name      string `json:"name"`
		Position  string `json:"position"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
		Summary   string `json:"summary"`
		Location  *struct {
			Country string `json:"country"`
			City    string `json:"city"`
		} `json:"location"`
	} `json:"work"`
	Projects []struct {
		Name      string `json:"name"`
		Role      string `json:"role"`
		Customer  string `json:"customer"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
		Summary   string `json:"summary"`
	} `json:"projects"`
	Education []struct {
		Institution string `json:"institution"`
		Area        string `json:"area"`
		EndDate     string `json:"endDate"`
		Degree      string `json:"degree"`
	} `json:"education"`
	Skills []struct {
		Name string `json:"name"`
	} `json:"skills"`
	Languages []struct {
		Language string `json:"language"`
		Fluency  string `json:"fluency"`
	} `json:"languages"`
	Certificates []struct {
		Name string `json:"name"`
		Date string `json:"date"`
	} `json:"certificates"`
	Meta struct {
		TotalYears float64 `json:"totalYears"`
	} `json:"meta"`
}

type docText struct {
	experience, total, years, education, skills, languages, certificates, present, period, position, projects, role, customer, summary string
	lang, level, degree                                                                                                        map[string]string
}

var docTexts = map[string]docText{
	"en": {"Work experience", "Total experience", "years", "Education", "Skills", "Languages", "Certificates", "present", "Period", "Organisation and position",
		"Projects", "Role", "Customer", "Summary",
		map[string]string{"kk": "Kazakh", "ru": "Russian", "en": "English", "de": "German", "tr": "Turkish", "ko": "Korean", "uz": "Uzbek", "zh": "Chinese", "fr": "French"},
		map[string]string{"native": "native", "fluent": "fluent"},
		map[string]string{"secondary": "secondary education", "higher": "higher education", "college": "college", "bachelor": "bachelor's degree", "specialist": "specialist degree", "master": "master's degree", "mba": "MBA", "phd": "PhD"}},
	"ru": {"Опыт работы", "Общий стаж", "лет", "Образование", "Навыки", "Языки", "Сертификаты", "по настоящее время", "Период", "Организация и должность",
		"Проекты", "Роль", "Заказчик", "Краткая информация",
		map[string]string{"kk": "Казахский", "ru": "Русский", "en": "Английский", "de": "Немецкий", "tr": "Турецкий", "ko": "Корейский", "uz": "Узбекский", "zh": "Китайский", "fr": "Французский"},
		map[string]string{"native": "родной", "fluent": "свободно"},
		map[string]string{"secondary": "среднее образование", "higher": "высшее образование", "college": "колледж", "bachelor": "бакалавр", "specialist": "специалист", "master": "магистр", "mba": "MBA", "phd": "PhD / кандидат наук"}},
}

// placeLabels turns country codes and city ids of the engine into names in lang.
func placeLabels(meta json.RawMessage, lang string) func(country, city string) string {
	var m struct {
		Countries []struct{ Code, En, Ru string } `json:"countries"`
		Cities    []struct{ ID, En, Ru string }   `json:"cities"`
	}
	_ = json.Unmarshal(meta, &m)
	names := map[string]string{}
	pick := func(en, ru string) string {
		if lang == "ru" {
			return ru
		}
		return en
	}
	for _, c := range m.Countries {
		names["c:"+c.Code] = pick(c.En, c.Ru)
	}
	for _, c := range m.Cities {
		names["t:"+c.ID] = pick(c.En, c.Ru)
	}
	return func(country, city string) string {
		var parts []string
		if city != "" {
			if n := names["t:"+city]; n != "" {
				parts = append(parts, n)
			} else {
				parts = append(parts, city) // typed by hand
			}
		}
		if n := names["c:"+country]; n != "" {
			parts = append(parts, n)
		}
		return strings.Join(parts, ", ")
	}
}

// Export builds the CV of a candidate as a Word document (lang "en" or "ru")
// with name, title, experience, education, skills, languages and
// certificates; contacts are left out. The team adapts it to the form of a
// tender in Word, or prints the page /cv/<id>/print to PDF.
func (s *Service) Export(ctx context.Context, actor workflow.Actor, id, lang string) (string, []byte, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return "", nil, err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return "", nil, err
	}
	if len(c.Profile) == 0 {
		return "", nil, apperr.Validation("The CV is not parsed yet")
	}
	if _, ok := docTexts[lang]; !ok {
		lang = "en"
	}
	var p profile
	// Claude's translation into the export language, when it is up to date
	if err := json.Unmarshal(applyTexts(c.Profile, c.Translations[lang]), &p); err != nil {
		return "", nil, err
	}
	if c.FullName != "" {
		p.Basics.Name = c.FullName
	}
	meta, err := s.engine.Meta(ctx)
	if err != nil {
		return "", nil, err
	}
	body, err := buildDocx(&p, lang, placeLabels(meta, lang))
	if err != nil {
		return "", nil, err
	}
	if err := audit.Write(ctx, s.pool, audit.FromActor(actor, "candidate.export", "candidate", id,
		map[string]any{"code": c.Code, "format": "docx", "lang": lang})); err != nil {
		return "", nil, err
	}
	name := c.Code
	if p.Basics.Name != "" {
		name += " " + p.Basics.Name
	}
	return name + ".docx", body, nil
}

func esc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// run is a text run; empty text gives nothing.
func wrun(text string, bold bool, size int, color string) string {
	if text == "" {
		return ""
	}
	pr := ""
	if bold {
		pr += "<w:b/>"
	}
	if color != "" {
		pr += `<w:color w:val="` + color + `"/>`
	}
	if size > 0 {
		pr += fmt.Sprintf(`<w:sz w:val="%d"/>`, size*2)
	}
	return `<w:r><w:rPr>` + pr + `</w:rPr><w:t xml:space="preserve">` + esc(text) + `</w:t></w:r>`
}

func para(runs string, after int) string {
	return fmt.Sprintf(`<w:p><w:pPr><w:spacing w:after="%d"/></w:pPr>%s</w:p>`, after, runs)
}

func heading(text string) string {
	return `<w:p><w:pPr><w:spacing w:before="240" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="1F3A5F"/></w:pBdr></w:pPr>` +
		wrun(text, true, 12, "1F3A5F") + `</w:p>`
}

func ym(s, present string) string {
	if s == "" {
		return present
	}
	if len(s) == 7 && s[4] == '-' {
		return s[5:] + "." + s[:4]
	}
	return s
}

func cell(width int, content string) string {
	return fmt.Sprintf(`<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/></w:tcPr>%s</w:tc>`, width, content)
}

func buildDocx(p *profile, lang string, place func(country, city string) string) ([]byte, error) {
	t := docTexts[lang]
	var b strings.Builder
	b.WriteString(para(wrun(p.Basics.Name, true, 18, ""), 40))
	b.WriteString(para(wrun(p.Basics.Label, false, 12, "555555"), 120))
	if p.Meta.TotalYears > 0 {
		b.WriteString(para(wrun(t.total+": ", true, 0, "")+wrun(strconv.FormatFloat(p.Meta.TotalYears, 'f', -1, 64)+" "+t.years, false, 0, ""), 120))
	}
	if p.Basics.Summary != "" {
		b.WriteString(heading(t.summary))
		b.WriteString(para(wrun(p.Basics.Summary, false, 0, ""), 60))
	}
	if len(p.Work) > 0 {
		b.WriteString(heading(t.experience))
		b.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="9600" w:type="dxa"/><w:tblBorders>` +
			`<w:insideH w:val="single" w:sz="4" w:color="D0D7E2"/><w:bottom w:val="single" w:sz="4" w:color="D0D7E2"/>` +
			`</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
			`<w:tblGrid><w:gridCol w:w="2200"/><w:gridCol w:w="7400"/></w:tblGrid>`)
		b.WriteString(`<w:tr>` + cell(2200, para(wrun(t.period, true, 0, "555555"), 0)) + cell(7400, para(wrun(t.position, true, 0, "555555"), 0)) + `</w:tr>`)
		for _, w := range p.Work {
			period := ym(w.StartDate, "") + " - " + ym(w.EndDate, t.present)
			name := w.Name
			if w.Location != nil {
				if pl := place(w.Location.Country, w.Location.City); pl != "" {
					name = strings.TrimPrefix(name+", "+pl, ", ")
				}
			}
			right := para(wrun(name, true, 0, ""), 0) + para(wrun(w.Position, false, 0, ""), 40)
			if w.Summary != "" {
				right += para(wrun(w.Summary, false, 0, "333333"), 0)
			}
			b.WriteString(`<w:tr>` + cell(2200, para(wrun(period, false, 0, ""), 0)) + cell(7400, right) + `</w:tr>`)
		}
		b.WriteString(`</w:tbl>`)
	}
	if len(p.Projects) > 0 {
		b.WriteString(heading(t.projects))
		for _, x := range p.Projects {
			title := wrun(x.Name, true, 0, "")
			if x.StartDate != "" || x.EndDate != "" {
				title += wrun("  "+ym(x.StartDate, "")+" - "+ym(x.EndDate, t.present), false, 0, "555555")
			}
			b.WriteString(para(title, 20))
			var meta []string
			if x.Role != "" {
				meta = append(meta, t.role+": "+x.Role)
			}
			if x.Customer != "" {
				meta = append(meta, t.customer+": "+x.Customer)
			}
			if len(meta) > 0 {
				b.WriteString(para(wrun(strings.Join(meta, "; "), false, 0, "333333"), 20))
			}
			if x.Summary != "" {
				b.WriteString(para(wrun(x.Summary, false, 0, ""), 80))
			}
		}
	}
	if len(p.Education) > 0 {
		b.WriteString(heading(t.education))
		for _, e := range p.Education {
			// "University, Area (degree)"; without the institution the level leads: "higher education, Area"
			d := t.degree[e.Degree]
			parts := []string{}
			for _, s := range []string{e.Institution, e.Area} {
				if s != "" {
					parts = append(parts, s)
				}
			}
			line := strings.Join(parts, ", ")
			switch {
			case e.Institution == "" && d != "":
				line = strings.TrimSuffix(d+", "+line, ", ")
			case d != "":
				line += " (" + d + ")"
			}
			b.WriteString(para(wrun(e.EndDate+"  ", true, 0, "")+wrun(line, false, 0, ""), 60))
		}
	}
	if len(p.Skills) > 0 {
		names := make([]string, len(p.Skills))
		for i, sk := range p.Skills {
			names[i] = sk.Name
		}
		b.WriteString(heading(t.skills))
		b.WriteString(para(wrun(strings.Join(names, ", "), false, 0, ""), 60))
	}
	if len(p.Languages) > 0 {
		b.WriteString(heading(t.languages))
		for _, l := range p.Languages {
			name := t.lang[l.Language]
			if name == "" {
				name = l.Language
			}
			level := t.level[l.Fluency]
			if level == "" {
				level = l.Fluency
			}
			line := name
			if level != "" {
				line += " - " + level
			}
			b.WriteString(para(wrun(line, false, 0, ""), 40))
		}
	}
	if len(p.Certificates) > 0 {
		b.WriteString(heading(t.certificates))
		for _, c := range p.Certificates {
			line := c.Name
			if c.Date != "" {
				line += " (" + c.Date + ")"
			}
			b.WriteString(para(wrun(line, false, 0, ""), 40))
		}
	}

	const ns = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
	parts := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
			`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
			`<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		"word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ` + ns + `><w:docDefaults><w:rPrDefault><w:rPr>` +
			`<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="21"/><w:lang w:val="` + map[string]string{"en": "en-GB", "ru": "ru-RU"}[lang] + `"/>` +
			`</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`,
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ` + ns + `><w:body>` + b.String() +
			`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>` +
			`</w:body></w:document>`,
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/styles.xml", "word/document.xml"} {
		f, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := f.Write([]byte(parts[name])); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
