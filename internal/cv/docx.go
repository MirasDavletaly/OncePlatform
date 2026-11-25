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
	"time"

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
	recommended, profile, total, experience, periodH, employer, role, duties, projects, customer, education,
	certificates, skills, languages, present, mo, mos string
	months           [12]string
	years            func(n int) string
	lang, level, deg map[string]string
}

var docTexts = map[string]docText{
	"en": {"Recommended position", "Profile", "Total experience", "Experience", "Period", "Employer", "Role", "Key responsibilities",
		"Projects", "Customer", "Education", "Certifications", "Skills and software", "Languages", "Present", "mo", "mos",
		[12]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"},
		func(n int) string { return plural(n, "yr", "yrs", "yrs") },
		map[string]string{"kk": "Kazakh", "ru": "Russian", "en": "English", "de": "German", "tr": "Turkish", "ko": "Korean", "uz": "Uzbek", "zh": "Chinese", "fr": "French"},
		map[string]string{"native": "native", "fluent": "fluent"},
		map[string]string{"secondary": "Secondary education", "higher": "Higher education", "college": "College", "bachelor": "Bachelor's degree", "specialist": "Specialist degree", "master": "Master's degree", "mba": "MBA", "phd": "PhD"}},
	"ru": {"Рекомендуемая должность", "Профиль", "Общий стаж", "Опыт работы", "Период", "Работодатель", "Должность", "Основные обязанности",
		"Проекты", "Заказчик", "Образование", "Сертификаты", "Навыки и программы", "Языки", "по н.в.", "мес.", "мес.",
		[12]string{"янв.", "фев.", "мар.", "апр.", "май", "июн.", "июл.", "авг.", "сен.", "окт.", "ноя.", "дек."},
		func(n int) string { return plural(n, "год", "года", "лет") },
		map[string]string{"kk": "Казахский", "ru": "Русский", "en": "Английский", "de": "Немецкий", "tr": "Турецкий", "ko": "Корейский", "uz": "Узбекский", "zh": "Китайский", "fr": "Французский"},
		map[string]string{"native": "родной", "fluent": "свободно"},
		map[string]string{"secondary": "Среднее образование", "higher": "Высшее образование", "college": "Колледж", "bachelor": "Бакалавр", "specialist": "Специалист", "master": "Магистр", "mba": "MBA", "phd": "PhD / кандидат наук"}},
}

// plural picks the form for 1, 2-4 and 5+ (Russian rules; English passes the same word twice).
func plural(n int, one, few, many string) string {
	switch {
	case n%10 == 1 && n%100 != 11:
		return one
	case n%10 >= 2 && n%10 <= 4 && (n%100 < 12 || n%100 > 14):
		return few
	}
	return many
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

// Export builds the standard CV of a candidate as a Word document (lang "en" or
// "ru"), on the letterhead of a company ("knt", "gs") or without one ("");
// contacts are left out. The team adapts it to the form of a tender in Word, or
// prints the page /cv/<id>/print to PDF.
func (s *Service) Export(ctx context.Context, actor workflow.Actor, id, lang, letterhead string) (string, []byte, error) {
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
	lh, err := s.letterheadFor(ctx, letterhead)
	if err != nil {
		return "", nil, err
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
	body, err := buildDocx(&p, lang, placeLabels(meta, lang), lh, time.Now())
	if err != nil {
		return "", nil, err
	}
	if err := audit.Write(ctx, s.pool, audit.FromActor(actor, "candidate.export", "candidate", id,
		map[string]any{"code": c.Code, "format": "docx", "lang": lang, "letterhead": letterhead})); err != nil {
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

// fmtRun is the look of a text run.
type fmtRun struct {
	bold, italic bool
	size         float64 // points; 0 = the default 10
	color        string
}

func wrun(text string, f fmtRun) string {
	if text == "" {
		return ""
	}
	pr := ""
	if f.bold {
		pr += "<w:b/>"
	}
	if f.italic {
		pr += "<w:i/>"
	}
	if f.color != "" {
		pr += `<w:color w:val="` + f.color + `"/>`
	}
	if f.size > 0 {
		pr += fmt.Sprintf(`<w:sz w:val="%d"/>`, int(f.size*2))
	}
	return `<w:r><w:rPr>` + pr + `</w:rPr><w:t xml:space="preserve">` + esc(text) + `</w:t></w:r>`
}

func para(runs string, before, after int) string {
	return fmt.Sprintf(`<w:p><w:pPr><w:spacing w:before="%d" w:after="%d"/></w:pPr>%s</w:p>`, before, after, runs)
}

func bullet(runs string) string {
	return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/></w:pPr>` + runs + `</w:p>`
}

const navy = "1F3864"

func heading(text string) string {
	return para(wrun(text, fmtRun{bold: true, size: 11, color: navy}), 200, 80)
}

// month is "Jul 2024" of "2024-07"; a year alone stays as it is.
func (t docText) month(s string) string {
	if len(s) == 7 && s[4] == '-' {
		if m, err := strconv.Atoi(s[5:]); err == nil && m >= 1 && m <= 12 {
			return t.months[m-1] + " " + s[:4]
		}
	}
	return s
}

// ymN is the month number of "2024-07" (or of a year: January, December at the end).
func ymN(s string, end bool) (int, bool) {
	y, err := strconv.Atoi(s[:min(4, len(s))])
	if err != nil || len(s) < 4 {
		return 0, false
	}
	m := 1
	if end {
		m = 12
	}
	if len(s) == 7 {
		if m, err = strconv.Atoi(s[5:]); err != nil {
			return 0, false
		}
	}
	return y*12 + m - 1, true
}

// span: "Jul 2024 – Jun 2026 (2 yrs)", months counted inclusively; an open end runs to now.
func (t docText) span(start, end string, now time.Time) string {
	if start == "" && end == "" {
		return ""
	}
	out := t.present
	if end != "" {
		out = t.month(end)
	}
	if start == "" {
		return out
	}
	out = t.month(start) + " – " + out
	a, ok := ymN(start, false)
	b, okb := now.Year()*12+int(now.Month())-1, true
	if end != "" {
		b, okb = ymN(end, true)
	}
	if !ok || !okb || b < a {
		return out
	}
	n := b - a + 1
	y, m := n/12, n%12
	var parts []string
	if y > 0 {
		parts = append(parts, fmt.Sprintf("%d %s", y, t.years(y)))
	}
	if m > 0 {
		unit := t.mos
		if m == 1 {
			unit = t.mo
		}
		parts = append(parts, fmt.Sprintf("%d %s", m, unit))
	}
	return out + " (" + strings.Join(parts, " ") + ")"
}

func cell(width int, content string, fill string) string {
	shd := ""
	if fill != "" {
		shd = `<w:shd w:val="clear" w:color="auto" w:fill="` + fill + `"/>`
	}
	return fmt.Sprintf(`<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/>%s</w:tcPr>%s</w:tc>`, width, shd, content)
}

func joinNonEmpty(sep string, xs ...string) string {
	var out []string
	for _, x := range xs {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return strings.Join(out, sep)
}

// The layout of the team's standard CV: name, recommended position, profile, a table of experience (period,
// employer, role, key responsibilities), projects, education, certifications, skills and languages; on a
// company letterhead (logo with the company lines in the header, the company in the footer) or without one.
func buildDocx(p *profile, lang string, place func(country, city string) string, lh *docLetterhead, now time.Time) ([]byte, error) {
	t := docTexts[lang]
	small := fmtRun{size: 9}
	var b strings.Builder
	b.WriteString(para(wrun(p.Basics.Name, fmtRun{bold: true, size: 15, color: navy}), 120, 80))
	if p.Basics.Label != "" {
		b.WriteString(para(wrun(t.recommended+": "+p.Basics.Label, fmtRun{italic: true, color: "595959"}), 0, 120))
	}
	total := ""
	if y := p.Meta.TotalYears; y > 0 {
		n, unit := strconv.FormatFloat(y, 'f', -1, 64), t.years(int(y))
		if y != float64(int(y)) { // "12.5 года", "12,5 года"
			unit = t.years(2)
			if lang == "ru" {
				n = strings.Replace(n, ".", ",", 1)
			}
		}
		total = t.total + ": " + n + " " + unit
	}
	if p.Basics.Summary != "" || total != "" {
		b.WriteString(heading(t.profile))
		if p.Basics.Summary != "" {
			b.WriteString(para(wrun(p.Basics.Summary, fmtRun{}), 0, 80))
		}
		if total != "" {
			b.WriteString(para(wrun(total, fmtRun{}), 0, 80))
		}
	}
	if len(p.Work) > 0 {
		b.WriteString(heading(t.experience))
		widths := []int{1830, 2310, 2025, 2861}
		b.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="9026" w:type="dxa"/><w:tblBorders>` +
			`<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>` +
			`<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>` +
			`<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>` +
			`</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>` +
			`<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>`)
		for _, w := range widths {
			fmt.Fprintf(&b, `<w:gridCol w:w="%d"/>`, w)
		}
		b.WriteString(`</w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>`)
		for i, h := range []string{t.periodH, t.employer, t.role, t.duties} {
			b.WriteString(cell(widths[i], para(wrun(h, fmtRun{bold: true, size: 9, color: "FFFFFF"}), 0, 0), navy))
		}
		b.WriteString(`</w:tr>`)
		for _, w := range p.Work {
			employer := w.Name
			if w.Location != nil {
				employer = joinNonEmpty(", ", employer, place(w.Location.Country, w.Location.City))
			}
			b.WriteString(`<w:tr><w:trPr><w:cantSplit/></w:trPr>`)
			for i, v := range []string{t.span(w.StartDate, w.EndDate, now), employer, w.Position, w.Summary} {
				b.WriteString(cell(widths[i], para(wrun(v, small), 0, 0), ""))
			}
			b.WriteString(`</w:tr>`)
		}
		b.WriteString(`</w:tbl>`)
		b.WriteString(para("", 0, 60))
	}
	if len(p.Projects) > 0 {
		b.WriteString(heading(t.projects))
		for _, x := range p.Projects {
			runs := wrun(x.Name, fmtRun{bold: true})
			if x.StartDate != "" || x.EndDate != "" {
				runs += wrun(" ("+t.span(x.StartDate, x.EndDate, now)+")", fmtRun{color: "595959"})
			}
			customer := ""
			if x.Customer != "" {
				customer = t.customer + ": " + x.Customer
			}
			details := joinNonEmpty("; ", x.Role, customer, x.Summary)
			if details != "" {
				runs += wrun(" – "+details, fmtRun{})
			}
			b.WriteString(bullet(runs))
		}
	}
	if len(p.Education) > 0 {
		b.WriteString(heading(t.education))
		for _, e := range p.Education {
			// "Master's degree – Information systems, University, 2007"
			line := joinNonEmpty(", ", e.Area, e.Institution, e.EndDate)
			if d := t.deg[e.Degree]; d != "" {
				line = joinNonEmpty(" – ", d, line)
			}
			b.WriteString(bullet(wrun(line, fmtRun{})))
		}
	}
	if len(p.Certificates) > 0 {
		b.WriteString(heading(t.certificates))
		for _, c := range p.Certificates {
			line := c.Name
			if c.Date != "" {
				line += " (" + c.Date + ")"
			}
			b.WriteString(bullet(wrun(line, fmtRun{})))
		}
	}
	if len(p.Skills) > 0 {
		names := make([]string, len(p.Skills))
		for i, sk := range p.Skills {
			names[i] = sk.Name
		}
		b.WriteString(heading(t.skills))
		b.WriteString(para(wrun(strings.Join(names, ", ")+".", fmtRun{}), 0, 80))
	}
	if len(p.Languages) > 0 {
		var ls []string
		for _, l := range p.Languages {
			name := t.lang[l.Language]
			if name == "" {
				name = l.Language
			}
			if level := t.level[l.Fluency]; level != "" {
				name += " (" + level + ")"
			} else if l.Fluency != "" {
				name += " (" + l.Fluency + ")"
			}
			ls = append(ls, name)
		}
		b.WriteString(heading(t.languages))
		b.WriteString(para(wrun(strings.Join(ls, ", "), fmtRun{}), 0, 80))
	}

	const ns = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
	const relType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
	types := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
		`<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>` +
		`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
		`<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
		`<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`
	docRels := rels + `<Relationship Id="rId1" Type="` + relType + `styles" Target="styles.xml"/><Relationship Id="rId2" Type="` + relType + `numbering" Target="numbering.xml"/>`
	parts := map[string][]byte{}
	sect := `<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1440" w:bottom="1134" w:left="1440" w:header="500" w:footer="500" w:gutter="0"/>`
	if lh != nil {
		// a line of the letterhead; "*text*" is written in italics
		line := func(text string, f fmtRun) string {
			if len(text) > 2 && strings.HasPrefix(text, "*") && strings.HasSuffix(text, "*") {
				text, f.italic = strings.Trim(text, "*"), true
			}
			return wrun(text, f)
		}
		hdr := `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
			fmt.Sprintf(`<wp:extent cx="%d" cy="%d"/><wp:docPr id="1" name="Logo"/>`, lh.width, lh.height) +
			`<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
			`<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="logo"/><pic:cNvPicPr/></pic:nvPicPr>` +
			`<pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
			fmt.Sprintf(`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`, lh.width, lh.height) +
			`</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
		for i, l := range lh.header {
			hdr += para(line(l, fmtRun{size: 8, color: "404040", bold: i == 0}), 0, 0)
		}
		hdr += `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="` + navy + `"/></w:pBdr><w:spacing w:after="120"/></w:pPr></w:p>`
		parts["word/header1.xml"] = []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ` + ns +
			` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` + hdr + `</w:hdr>`)
		parts["word/_rels/header1.xml.rels"] = []byte(rels + `<Relationship Id="rIdLogo" Type="` + relType + `image" Target="media/logo.` + lh.ext + `"/></Relationships>`)
		parts["word/media/logo."+lh.ext] = lh.logo
		types += `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`
		docRels += `<Relationship Id="rIdH" Type="` + relType + `header" Target="header1.xml"/>`
		refs := `<w:headerReference w:type="default" r:id="rIdH"/>`
		if len(lh.footer) > 0 {
			ftr := ""
			for i, l := range lh.footer {
				if i == 0 { // the company, under a rule
					ftr += `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="6" w:space="4" w:color="` + navy + `"/></w:pBdr><w:spacing w:after="0"/></w:pPr>` +
						line(l, fmtRun{bold: true, size: 8, color: navy}) + `</w:p>`
					continue
				}
				ftr += para(line(l, fmtRun{size: 8, color: "595959"}), 0, 0)
			}
			parts["word/footer1.xml"] = []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ` + ns + `>` + ftr + `</w:ftr>`)
			types += `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`
			docRels += `<Relationship Id="rIdF" Type="` + relType + `footer" Target="footer1.xml"/>`
			refs += `<w:footerReference w:type="default" r:id="rIdF"/>`
		}
		sect = refs + strings.Replace(sect, `w:top="1134"`, `w:top="2200"`, 1)
	}
	parts["[Content_Types].xml"] = []byte(types + `</Types>`)
	parts["_rels/.rels"] = []byte(rels + `<Relationship Id="rId1" Type="` + relType + `officeDocument" Target="word/document.xml"/></Relationships>`)
	parts["word/_rels/document.xml.rels"] = []byte(docRels + `</Relationships>`)
	parts["word/styles.xml"] = []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>` +
		`<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:lang w:val="` + map[string]string{"en": "en-GB", "ru": "ru-RU"}[lang] + `"/>` +
		`</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`)
	parts["word/numbering.xml"] = []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>` +
		`<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl></w:abstractNum>` +
		`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`)
	parts["word/document.xml"] = []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ` + ns + `><w:body>` + b.String() +
		`<w:sectPr>` + sect + `</w:sectPr></w:body></w:document>`)

	order := []string{"[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/styles.xml", "word/numbering.xml", "word/document.xml",
		"word/header1.xml", "word/_rels/header1.xml.rels", "word/footer1.xml"}
	if lh != nil {
		order = append(order, "word/media/logo."+lh.ext)
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, name := range order {
		body, ok := parts[name]
		if !ok {
			continue
		}
		f, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := f.Write(body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
