package notify

import (
	"reflect"
	"testing"
)

func TestParseMentions(t *testing.T) {
	cases := map[string][]string{
		"Привет @Мирас, посмотри":              {"мирас"},
		"@dinara и @miras.k, срочно.":          {"dinara", "miras.k"},
		"почта miras@company.kz не упоминание": nil,
		"@Динара @динара повтор":               {"динара"},
		"(@Айгүл) казахские буквы":             {"айгүл"},
		"без упоминаний":                       nil,
		"конец предложения @miras.":            {"miras"},
	}
	for in, want := range cases {
		got := ParseMentions(in)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ParseMentions(%q) = %v, want %v", in, got, want)
		}
	}
}
